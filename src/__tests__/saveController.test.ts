/**
 * The save controller's rules, with a controllable clock and a fake project.
 * The headline case is the race the old autosave would have had with files:
 * edit A, switch to B inside the debounce, and the timer must NOT write
 * anything into either file afterwards.
 */

import { describe, expect, it } from 'vitest';
import { SaveController } from '../core/saveController';

function harness(options: { failWrites?: boolean } = {}) {
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const disk = new Map<string, string>();
  const writes: string[] = [];
  const project = { text: 'A0' };
  let fail = options.failWrites ?? false;
  const controller = new SaveController({
    serialize: () => project.text,
    write: async (fileId, text) => {
      if (fail) throw new Error('disk full');
      disk.set(fileId, text);
      writes.push(`${fileId}=${text}`);
    },
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  const fireTimers = async () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    controller,
    project,
    disk,
    writes,
    timers,
    fireTimers,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

describe('SaveController', () => {
  it('auto-saves the open file after the delay, once per burst', async () => {
    const { controller, project, writes, timers, fireTimers } = harness();
    await controller.switchTo('A', true);
    project.text = 'A1';
    controller.markChanged();
    project.text = 'A2';
    controller.markChanged();
    expect(timers.size).toBe(1);
    expect(controller.isDirty('A')).toBe(true);
    await fireTimers();
    expect(writes).toEqual(['A=A2']);
    expect(controller.isDirty('A')).toBe(false);
  });

  it('THE RACE: a timer armed for A never writes after switching to B', async () => {
    const { controller, project, disk, fireTimers } = harness();
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    // Switch within the debounce. With auto-save ON the edit is written to A
    // during the switch, from A's content.
    await controller.switchTo('B', true);
    project.text = 'B-content'; // B is now loaded
    await fireTimers(); // anything still armed fires now
    expect(disk.get('A')).toBe('A-edit');
    expect(disk.has('B')).toBe(false);
  });

  it('a timer from a previous open of the SAME file is retired too', async () => {
    const { controller, project, writes, fireTimers } = harness();
    await controller.switchTo('A', true);
    project.text = 'A1';
    controller.markChanged();
    await controller.switchTo('A', true); // re-open A (e.g. after a reload)
    await fireTimers();
    expect(writes).toEqual([]);
  });

  it('with auto-save OFF, switching away keeps the edit as a buffer, not a write', async () => {
    const { controller, project, writes, fireTimers } = harness();
    await controller.setSettings({ enabled: false, delaySeconds: 1 });
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    await fireTimers();
    expect(writes).toEqual([]);
    await controller.switchTo('B', true);
    expect(controller.isDirty('A')).toBe(true);
    expect(controller.hasUnsavedWork()).toBe(true);
    expect(controller.takeBuffer('A')).toBe('A-edit');
    expect(controller.takeBuffer('A')).toBeUndefined();
  });

  it('Ctrl+S saves the open file even with auto-save off', async () => {
    const { controller, project, writes } = harness();
    await controller.setSettings({ enabled: false, delaySeconds: 1 });
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    await controller.save();
    expect(writes).toEqual(['A=A-edit']);
    expect(controller.isDirty('A')).toBe(false);
  });

  it('turning auto-save ON writes every buffer and the open file at once', async () => {
    const { controller, project, disk } = harness();
    await controller.setSettings({ enabled: false, delaySeconds: 1 });
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    await controller.switchTo('B', true);
    project.text = 'B-edit';
    controller.markChanged();
    await controller.setSettings({ enabled: true, delaySeconds: 1 });
    expect(disk.get('A')).toBe('A-edit');
    expect(disk.get('B')).toBe('B-edit');
    expect(controller.hasUnsavedWork()).toBe(false);
  });

  it('a FAILED save during a switch is kept as a buffer, never dropped', async () => {
    const { controller, project, setFail } = harness();
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    setFail(true);
    await controller.switchTo('B', true);
    expect(controller.isDirty('A')).toBe(true);
    expect(controller.takeBuffer('A')).toBe('A-edit');
  });

  it('a failed save of the open file leaves it unsaved', async () => {
    const { controller, project, setFail } = harness();
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    setFail(true);
    await expect(controller.save()).rejects.toThrow('disk full');
    expect(controller.isDirty('A')).toBe(true);
  });

  it('never writes to a file that is not writable', async () => {
    const { controller, project, writes, timers } = harness();
    await controller.switchTo('broken', false);
    project.text = 'anything';
    controller.markChanged();
    expect(timers.size).toBe(0);
    await controller.save();
    expect(writes).toEqual([]);
    expect(controller.isDirty('broken')).toBe(false);
  });

  it('only BUFFERED files count as work a closing tab would lose', async () => {
    // The open file's pending edit is carried by the journal, so it must not
    // trigger "Leave site?" — that prompted on every reload within the save
    // delay. A buffered file (auto-save off, switched away) has no journal.
    const { controller, project } = harness();
    await controller.setSettings({ enabled: false, delaySeconds: 1 });
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    expect(controller.hasUnsavedWork()).toBe(true);
    expect(controller.hasBufferedFiles()).toBe(false);
    await controller.switchTo('B', true);
    expect(controller.hasBufferedFiles()).toBe(true);
  });

  it('forgetting the open file closes it and drops its pending save', async () => {
    const { controller, project, writes, fireTimers } = harness();
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    controller.forget(['A']);
    await fireTimers();
    expect(writes).toEqual([]);
    expect(controller.activeFileId).toBeNull();
  });

  it('saveBuffered writes a closed tab\'s buffer, and keeps it if the write fails', async () => {
    const { controller, project, disk, setFail } = harness();
    await controller.setSettings({ enabled: false, delaySeconds: 1 });
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    await controller.switchTo('B', true);
    setFail(true);
    await expect(controller.saveBuffered('A')).rejects.toThrow('disk full');
    expect(controller.isDirty('A')).toBe(true);
    setFail(false);
    await controller.saveBuffered('A');
    expect(disk.get('A')).toBe('A-edit');
    expect(controller.isDirty('A')).toBe(false);
  });

  it('a buffer taken for a superseded open is put back, never over a newer one', async () => {
    const { controller, project } = harness();
    await controller.setSettings({ enabled: false, delaySeconds: 1 });
    await controller.switchTo('A', true);
    project.text = 'A-edit';
    controller.markChanged();
    await controller.switchTo('B', true);
    // Opening A took its buffer, then a second click went to C first.
    const taken = controller.takeBuffer('A')!;
    controller.restoreBuffer('A', taken);
    expect(controller.isDirty('A')).toBe(true);
    // A buffer made since the take wins; the open file never gets one.
    controller.restoreBuffer('A', 'stale');
    expect(controller.takeBuffer('A')).toBe('A-edit');
    controller.restoreBuffer('B', 'B-stale');
    expect(controller.takeBuffer('B')).toBeUndefined();
  });
});
