/**
 * The workspace's rules, ported from the scenarios Nodestra verified live
 * in Chrome (.claude/plans/file-library.md "Outcome", and the fixes in
 * review/2026-09-26-library/TRIAGE.md), as node tests: a fake editor
 * behind a DocumentAdapter, a controllable clock, the in-memory library and
 * memfs folders with `move` stripped (stable Chrome).
 */

import { describe, expect, it, vi } from 'vitest';
import { fsa } from 'memfs/lib/fsa';
import { FileLibrary } from '../core/fileLibrary';
import { createMemoryStore } from '../core/keyValueStore';
import type { KeyValueStore } from '../core/keyValueStore';
import { findByPath } from '../core/libraryTree';
import { extensionPolicy } from '../core/policy';
import type { FilePolicy } from '../core/policy';
import type { SaveSettings } from '../core/saveController';
import { defineTabKinds, tabId } from '../core/tabKinds';
import { Workspace } from '../core/workspace';
import type {
  ConfirmRequest,
  DocumentAdapter,
  Journal,
  JournalEntry,
  UnsavedChoice,
} from '../core/workspace';

const policy = extensionPolicy({ openable: ['.json'], content: 'text', defaultExtension: '.json' });
const videoPolicy = extensionPolicy({ openable: ['.mp4'], content: 'binary' });
const kinds = defineTabKinds({
  file: { persist: 'file' },
  welcome: { persist: 'key', legacyIds: ['@welcome'] },
  share: { persist: false },
});
const WELCOME = tabId('welcome');
const SHARE = tabId('share', 'p1');
const fileTab = (id: string) => tabId('file', id);
const AUTOSAVE_ON: SaveSettings = { enabled: true, delaySeconds: 0.8 };
const AUTOSAVE_OFF: SaveSettings = { enabled: false, delaySeconds: 0.8 };

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

// ── a controllable clock ────────────────────────────────────────────────

function manualTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  const timers = {
    set: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clear: (handle: unknown) => {
      pending.delete(handle as number);
    },
  };
  /** Fire the pending timers (only those of `ms`, if given). */
  async function fire(ms?: number) {
    const due = [...pending].filter(([, timer]) => ms === undefined || timer.ms === ms);
    for (const [id] of due) pending.delete(id);
    for (const [, timer] of due) timer.callback();
    await tick();
  }
  async function runAll() {
    for (let round = 0; round < 10 && pending.size > 0; round += 1) await fire();
  }
  return { timers, fire, runAll };
}

// ── a fake editor: file text is "doc:<text>" ────────────────────────────

type Doc = { text: string; history: number };

function fakeEditor() {
  const editor = {
    doc: null as Doc | null,
    log: [] as string[],
    /** Hold a file's load until released (an open "in flight"). */
    gates: new Map<string, Promise<void>>(),
  };
  const adapter: DocumentAdapter<Doc, Doc> = {
    async load(file) {
      const gate = editor.gates.get(file.node.name);
      if (gate) await gate;
      const text = await file.readText();
      if (!text.startsWith('doc:')) return { ok: false, detail: 'not a doc' };
      const body = text.slice(4);
      return {
        ok: true,
        content: { text: body.replace('!', ''), history: 0 },
        // "!" marks an old format that loads with repairs.
        warnings: body.includes('!') ? ['repaired'] : undefined,
      };
    },
    install(content) {
      editor.doc = { ...content };
      editor.log.push(`install:${content.text}`);
    },
    restore(snapshot) {
      editor.doc = { ...snapshot };
      editor.log.push(`restore:${snapshot.text}`);
    },
    capture() {
      return { ...(editor.doc as Doc) };
    },
    closeEditor() {
      editor.doc = null;
      editor.log.push('close');
    },
    silence() {
      editor.log.push('silence');
    },
    serialize() {
      return `doc:${editor.doc?.text ?? ''}`;
    },
  };
  return { editor, adapter };
}

type SetupOptions = {
  files?: Record<string, string>;
  save?: SaveSettings | false;
  store?: KeyValueStore;
  library?: FileLibrary;
  policy?: FilePolicy;
  confirmUnsaved?: (names: readonly string[]) => Promise<UnsavedChoice>;
  confirm?: (request: ConfirmRequest) => Promise<boolean>;
  beforeCloseTabs?: (ids: readonly string[]) => Promise<boolean>;
  journal?: Journal;
  onStartupOpened?: (count: number) => void;
  adapter?: DocumentAdapter<Doc, Doc>;
  boot?: boolean;
  readOnly?: boolean;
};

async function setup(options: SetupOptions = {}) {
  const store = options.store ?? createMemoryStore();
  const library = options.library ?? new FileLibrary({ store, policy: options.policy ?? policy });
  const clock = manualTimers();
  const fake = fakeEditor();
  const editor = fake.editor;
  const adapter = options.adapter ?? fake.adapter;
  const ws = new Workspace<Doc, Doc>({
    library,
    kinds,
    documents: adapter,
    timers: clock.timers,
    welcomeTab: WELCOME,
    save: options.save ?? AUTOSAVE_ON,
    readOnly: options.readOnly,
    confirmUnsaved: options.confirmUnsaved,
    confirm: options.confirm,
    beforeCloseTabs: options.beforeCloseTabs,
    journal: options.journal,
    startup: { onStartupOpened: options.onStartupOpened },
    label: ({ kind, key }) => (kind === 'share' ? `Stream ${key}` : undefined),
  });
  if (options.boot !== false) await ws.boot();
  const ids: Record<string, string> = {};
  for (const [name, text] of Object.entries(options.files ?? {})) {
    ids[name] = await library.createFile(library.tree.rootId, name, text);
  }
  /** The user edits the open document. */
  const edit = (text: string) => {
    (editor.doc as Doc).text = text;
    (editor.doc as Doc).history += 1;
    ws.contentChanged();
  };
  /** Open a file and let the editor settle (the baseline is taken). */
  const open = async (id: string, openOptions?: { preview?: boolean }) => {
    await ws.openFile(id, openOptions);
    await clock.fire(300);
  };
  return { ws, library, store, editor, clock, ids, edit, open, read: (id: string) => library.readText(id) };
}

type Dir = FileSystemDirectoryHandle;

async function makeFolder(files: Record<string, string>): Promise<Dir> {
  const { dir } = fsa({ mode: 'readwrite' });
  const root = dir as unknown as Dir;
  for (const [name, text] of Object.entries(files)) await writeDisk(root, name, text);
  const proto = Object.getPrototypeOf(root) as { move?: unknown };
  if ('move' in proto) delete proto.move;
  return root;
}

async function writeDisk(root: Dir, name: string, text: string): Promise<void> {
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function readDisk(root: Dir, name: string): Promise<string | undefined> {
  try {
    return await (await (await root.getFileHandle(name)).getFile()).text();
  } catch {
    return undefined;
  }
}

/** A workspace over a linked memfs folder. */
async function setupFolder(files: Record<string, string>, options: SetupOptions = {}) {
  const root = await makeFolder(files);
  const context = await setup(options);
  expect(await context.ws.link(root)).toBe(true);
  const id = (name: string) => findByPath(context.library.tree, [name])!.id;
  return { ...context, root, id };
}

// ─────────────────────────────────────────────────────────────────────────

describe('Workspace — switching files', () => {
  it('THE RACE: edit A, switch to B at once → the edit is saved to A, never to B', async () => {
    const { ws, ids, edit, open, read, clock, editor } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B' },
    });
    const [a, b] = [ids['a.json'], ids['b.json']];
    await open(a);
    edit('A edited');
    // Inside BOTH the settle window and the save delay (W1).
    await ws.openFile(b);
    expect(editor.doc?.text).toBe('B');
    expect(await read(a)).toBe('doc:A edited');
    await clock.runAll(); // every late timer
    expect(await read(b)).toBe('doc:B');
    expect(await read(a)).toBe('doc:A edited');
    expect(ws.isFileDirty(a)).toBe(false);
    // W4: the switch's own save does not make A's snapshot look stale.
    await ws.openFile(a);
    expect(editor.log.at(-1)).toBe('restore:A edited');
    expect(editor.doc?.history).toBe(1);
  });

  it('THE RACE after the edit settled (save timer armed): still A only', async () => {
    const { ws, ids, edit, open, read, clock } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B' },
    });
    const [a, b] = [ids['a.json'], ids['b.json']];
    await open(a);
    edit('A edited');
    await clock.fire(300); // dirty, the 800 ms save is pending
    expect(ws.getSnapshot().saveStatus).toBe('unsaved');
    await ws.openFile(b);
    await clock.runAll();
    expect(await read(a)).toBe('doc:A edited');
    expect(await read(b)).toBe('doc:B');
  });

  it('a fresh open is clean: the editor settling is not an edit (C1)', async () => {
    const { ws, ids, open, read, clock } = await setup({ files: { 'a.json': 'doc:A' } });
    await open(ids['a.json']);
    ws.contentChanged(); // the editor's own measurement
    await clock.runAll();
    expect(ws.getSnapshot().saveStatus).toBe('saved');
    expect(await read(ids['a.json'])).toBe('doc:A');
  });

  it('superseded open: B wins, A gets its taken buffer back (C2), and never B\'s content', async () => {
    const { ws, ids, edit, open, read, clock, editor } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B' },
      save: AUTOSAVE_OFF,
    });
    const [a, b] = [ids['a.json'], ids['b.json']];
    await open(a);
    edit('A edited');
    await clock.fire(300);
    await open(b); // auto-save off: A is kept as a buffer
    expect(ws.isFileDirty(a)).toBe(true);

    let release!: () => void;
    editor.gates.set('a.json', new Promise<void>((resolve) => (release = resolve)));
    const slow = ws.openFile(a); // takes A's buffer, then waits
    await tick();
    await ws.openFile(b); // the second click wins
    release();
    await slow;

    expect(ws.getSnapshot().tabs.active).toBe(fileTab(b));
    expect(editor.doc?.text).toBe('B');
    expect(ws.isFileDirty(a)).toBe(true); // given back
    expect(await read(a)).toBe('doc:A');

    editor.gates.clear();
    await ws.openFile(a);
    // W1b: the superseded open must not have filed B's content under A.
    expect(editor.doc?.text).toBe('A edited');
    expect(ws.getSnapshot().saveStatus).toBe('unsaved');
  });

  it('reuses a tab\'s snapshot (undo history) only while its file is unchanged', async () => {
    const { id, edit, open, clock, editor, root } = await setupFolder({
      'a.json': 'doc:A',
      'b.json': 'doc:B',
    });
    await open(id('a.json'));
    edit('A1');
    await clock.runAll(); // saved
    expect(await readDisk(root, 'a.json')).toBe('doc:A1');
    await open(id('b.json'));
    await open(id('a.json'));
    expect(editor.log.at(-1)).toBe('restore:A1');
    expect(editor.doc?.history).toBe(1); // the undo history came back

    await open(id('b.json'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeDisk(root, 'a.json', 'doc:outside'); // another program
    await open(id('a.json'));
    expect(editor.log.at(-1)).toBe('install:outside');
    expect(editor.doc?.history).toBe(0);
  });

  it('an edit makes nothing dirty while "Unsupported" is shown, and it is never written (E6)', async () => {
    const { ws, id, edit, open, clock, editor, root, library } = await setupFolder({
      'good.json': 'doc:G',
      'broken.json': '{ nope',
    });
    await open(id('good.json'));
    await ws.openFile(id('broken.json'));
    const state = ws.getSnapshot();
    expect(state.openFailure).toMatchObject({ name: 'broken.json', reason: 'unsupported' });
    expect(library.getSnapshot().unsupported.has(id('broken.json'))).toBe(true);
    expect(editor.log).toContain('silence');
    expect(state.saveStatus).toBe('unavailable');

    edit('G behind the overlay');
    await ws.saveNow();
    await clock.runAll();
    expect(await readDisk(root, 'broken.json')).toBe('{ nope');

    // Unlink keeps ids, but must not re-enable saving on this file (E6).
    const broken = id('broken.json');
    expect(await ws.unlink()).toBe(true);
    expect(ws.saveController?.isActiveWritable).toBe(false);
    edit('still behind');
    await clock.runAll();
    expect(await library.readText(broken)).toBe('{ nope');

    // The next click still works.
    await ws.openFile(id('good.json'));
    expect(ws.getSnapshot().openFailure).toBeNull();
    expect(editor.doc?.text).toBe('G');
  });

  it('a file that opened with warnings is backed up before its first save (B10)', async () => {
    const fake = fakeEditor();
    const backups: string[] = [];
    const adapter: DocumentAdapter<Doc, Doc> = {
      ...fake.adapter,
      async onFirstSaveOfWarnedFile(original, file) {
        backups.push(original);
        await file.library.createFile(file.node.parentId!, 'old (original).json', original);
      },
    };
    const { ws, ids, open, library, clock } = await setup({ files: { 'old.json': 'doc:old!' }, adapter });
    await open(ids['old.json']);
    (fake.editor.doc as Doc).text = 'new';
    ws.contentChanged();
    await clock.runAll();
    await ws.saveNow();
    expect(backups).toEqual(['doc:old!']);
    const backup = findByPath(library.tree, ['old (original).json'])!;
    expect(await library.readText(backup.id)).toBe('doc:old!');
    expect(await library.readText(ids['old.json'])).toBe('doc:new');
  });
});

describe('Workspace — closing tabs', () => {
  it('Close → "Don\'t save" sticks: the switch never saves the closing file', async () => {
    const asked: (readonly string[])[] = [];
    const { ws, ids, edit, open, read, clock, editor } = await setup({
      files: { 'a.json': 'doc:A' },
      confirmUnsaved: async (names) => {
        asked.push(names);
        return 'discard';
      },
    });
    await open(ids['a.json']);
    edit('A edited'); // not even settled yet: closing still asks (W1)
    await ws.closeTabs([fileTab(ids['a.json'])]);
    await clock.runAll();
    expect(asked).toEqual([['a.json']]);
    expect(await read(ids['a.json'])).toBe('doc:A');
    expect(ws.getSnapshot().tabs.order).toEqual([WELCOME]);
    expect(editor.doc).toBeNull();
    expect(ws.getSnapshot().activeFileId).toBeNull();
  });

  it('Close → Save writes first (a buffered, not-open file)', async () => {
    const { ws, ids, edit, open, read, clock } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B' },
      save: AUTOSAVE_OFF,
      confirmUnsaved: async () => 'save',
    });
    await open(ids['a.json']);
    edit('A edited');
    await open(ids['b.json']); // A buffered
    expect(await read(ids['a.json'])).toBe('doc:A');
    await ws.closeTabs([fileTab(ids['a.json'])]);
    expect(await read(ids['a.json'])).toBe('doc:A edited');
    expect(ws.isFileDirty(ids['a.json'])).toBe(false);
    expect(ws.hasUnsavedBuffers()).toBe(false);
    await clock.runAll();
  });

  it('Close → Save writes the open file first', async () => {
    const { ws, ids, edit, open, read } = await setup({
      files: { 'a.json': 'doc:A' },
      save: AUTOSAVE_OFF,
      confirmUnsaved: async () => 'save',
    });
    await open(ids['a.json']);
    edit('A edited');
    await ws.closeTabs([fileTab(ids['a.json'])]);
    expect(await read(ids['a.json'])).toBe('doc:A edited');
  });

  it('Close → Cancel keeps the tab, open and unsaved', async () => {
    const { ws, ids, edit, open, read, editor } = await setup({
      files: { 'a.json': 'doc:A' },
      save: AUTOSAVE_OFF,
      confirmUnsaved: async () => 'cancel',
    });
    await open(ids['a.json']);
    edit('A edited');
    await ws.closeTabs([fileTab(ids['a.json'])]);
    expect(ws.getSnapshot().tabs.active).toBe(fileTab(ids['a.json']));
    expect(ws.isDirty(fileTab(ids['a.json']))).toBe(true);
    expect(editor.doc?.text).toBe('A edited');
    expect(await read(ids['a.json'])).toBe('doc:A');
  });

  it('close family: others, to the right, saved, all', async () => {
    const { ws, ids, edit, open } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B', 'c.json': 'doc:C' },
      save: AUTOSAVE_OFF,
      confirmUnsaved: async () => 'discard',
    });
    const [a, b, c] = [ids['a.json'], ids['b.json'], ids['c.json']].map(fileTab);
    await open(ids['a.json']);
    await open(ids['b.json']);
    edit('B edited');
    await open(ids['c.json']);
    expect(ws.getSnapshot().tabs.order).toEqual([WELCOME, a, b, c]);
    await ws.closeSavedTabs();
    expect(ws.getSnapshot().tabs.order).toEqual([b]); // only the unsaved one stays
    expect(ws.getSnapshot().tabs.active).toBe(b);
    await open(ids['a.json']);
    await open(ids['c.json']);
    await ws.closeTabsToTheRight(b);
    expect(ws.getSnapshot().tabs.order).toEqual([b]);
    await open(ids['a.json']);
    await ws.closeOtherTabs(a);
    expect(ws.getSnapshot().tabs.order).toEqual([a]);
    await ws.closeAllTabs();
    expect(ws.getSnapshot().tabs.order).toEqual([]);
    expect(ws.getSnapshot().editorOpen).toBe(false);
  });

  it('reopens the last closed tab, unless its file is gone', async () => {
    const { ws, ids, open, editor, library } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B' },
    });
    await open(ids['a.json']);
    await open(ids['b.json']);
    await ws.closeTabs([fileTab(ids['b.json'])]);
    expect(editor.doc?.text).toBe('A');
    await ws.reopenClosedTab();
    expect(ws.getSnapshot().tabs.active).toBe(fileTab(ids['b.json']));
    expect(editor.doc?.text).toBe('B');

    await ws.closeTabs([fileTab(ids['a.json'])]);
    await library.remove([ids['a.json']]);
    const before = ws.getSnapshot().tabs;
    await ws.reopenClosedTab();
    expect(ws.getSnapshot().tabs.order).toEqual(before.order);
  });
});

describe('Workspace — library operations', () => {
  it('rename keeps the tab (same id) and its label follows; saves go to the renamed file', async () => {
    const { ws, ids, edit, open, read, clock, library } = await setup({ files: { 'a.json': 'doc:A' } });
    const a = ids['a.json'];
    await open(a);
    expect(await ws.rename(a, 'renamed.json')).toBe(true);
    expect(ws.getSnapshot().tabs.active).toBe(fileTab(a));
    expect(ws.label(fileTab(a))).toBe('renamed.json');
    expect(ws.getSnapshot().activeFileName).toBe('renamed.json');
    edit('A edited');
    await clock.runAll();
    expect(await read(a)).toBe('doc:A edited');
    expect(findByPath(library.tree, ['renamed.json'])?.id).toBe(a);
  });

  it('renaming the open file with a pending save flushes it first, without deadlock (A1)', async () => {
    const { ws, id, edit, open, clock, root } = await setupFolder({ 'a.json': 'doc:A' });
    await open(id('a.json'));
    edit('A edited');
    await clock.fire(300); // the save is pending, not done
    await ws.rename(id('a.json'), 'b.json'); // resolves: no deadlock
    expect(await readDisk(root, 'b.json')).toBe('doc:A edited');
    expect(await readDisk(root, 'a.json')).toBeUndefined();
  });

  it('deleted in the app (after confirm): the tab closes', async () => {
    const requests: ConfirmRequest[] = [];
    const { ws, ids, open, editor } = await setup({
      files: { 'a.json': 'doc:A' },
      confirm: async (request) => {
        requests.push(request);
        return true;
      },
    });
    await open(ids['a.json']);
    expect(await ws.remove([ids['a.json']])).toBe(true);
    expect(requests).toEqual([
      { kind: 'delete', label: '"a.json"', onDisk: false, openable: 1, otherFiles: 0, hidden: 0, permanent: 0 },
    ]);
    expect(ws.getSnapshot().tabs.order).toEqual([WELCOME]);
    expect(ws.getSnapshot().activeFileId).toBeNull();
    expect(editor.doc).toBeNull();
  });

  it('deleted OUTSIDE the app: the tab shows missing, keeps its name, and nothing saves (E6 / L11)', async () => {
    const { ws, id, edit, open, clock, root, library } = await setupFolder({
      'a.json': 'doc:A',
      'b.json': 'doc:B',
    });
    const a = id('a.json');
    await open(id('b.json'));
    await open(a);
    await root.removeEntry('a.json');
    await library.rescan({ force: true });
    const state = ws.getSnapshot();
    expect(ws.isTabMissing(fileTab(a))).toBe(true);
    expect(ws.label(fileTab(a))).toBe('a.json');
    expect(state.activeFileId).toBeNull();
    expect(state.detached).toBe(true); // "not saved in the library"
    edit('lost?');
    await clock.runAll();
    expect(await readDisk(root, 'a.json')).toBeUndefined();
    expect(await readDisk(root, 'b.json')).toBe('doc:B');
  });

  it('link discards the in-browser library\'s buffers and file tabs (E3)', async () => {
    const requests: ConfirmRequest[] = [];
    const { ws, ids, edit, open, clock, editor } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B' },
      save: AUTOSAVE_OFF,
      confirm: async (request) => {
        requests.push(request);
        return requests.length > 1; // refuse the first time
      },
    });
    await open(ids['a.json']);
    edit('A edited');
    await open(ids['b.json']); // A buffered
    await ws.openTab(SHARE);
    expect(ws.hasUnsavedBuffers()).toBe(true);
    const root = await makeFolder({ 'disk.json': 'doc:D' });

    expect(await ws.link(root)).toBe(false); // refused: nothing changes
    expect(ws.hasUnsavedBuffers()).toBe(true);
    expect(ws.getSnapshot().library.mode.kind).toBe('memory');

    expect(await ws.link(root)).toBe(true);
    expect(requests[1]).toEqual({ kind: 'link', folderName: root.name, openable: 2, folders: 0 });
    expect(ws.hasUnsavedBuffers()).toBe(false);
    expect(ws.getSnapshot().tabs.order).toEqual([WELCOME, SHARE]);
    expect(ws.getSnapshot().activeFileId).toBeNull();
    expect(editor.doc).toBeNull();
    await ws.setAutoSave({ enabled: true }); // no ghost buffer to write
    await clock.runAll();
    expect(ws.getSnapshot().library.error).toBeNull();
  });

  it('a save over a file changed outside the app pauses with a conflict; Overwrite wins (D2)', async () => {
    const { ws, id, edit, open, clock, root } = await setupFolder({ 'a.json': 'doc:A' });
    await open(id('a.json'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeDisk(root, 'a.json', 'doc:theirs');
    edit('mine');
    await clock.runAll();
    expect(ws.getSnapshot().conflict).toEqual({ fileId: id('a.json'), name: 'a.json' });
    expect(ws.getSnapshot().saveStatus).toBe('unavailable'); // paused
    expect(await readDisk(root, 'a.json')).toBe('doc:theirs');
    edit('mine 2');
    await clock.runAll(); // no timer-driven retries
    expect(await readDisk(root, 'a.json')).toBe('doc:theirs');

    await ws.overwriteConflict();
    expect(ws.getSnapshot().conflict).toBeNull();
    expect(await readDisk(root, 'a.json')).toBe('doc:mine 2');
    expect(ws.getSnapshot().saveStatus).toBe('saved');
  });

  it('a conflict resolved by Reload shows the disk version, clean', async () => {
    const { ws, id, edit, open, clock, root, editor } = await setupFolder({ 'a.json': 'doc:A' });
    await open(id('a.json'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeDisk(root, 'a.json', 'doc:theirs');
    edit('mine');
    await clock.runAll();
    await ws.reloadConflict();
    expect(editor.doc?.text).toBe('theirs');
    expect(ws.getSnapshot().conflict).toBeNull();
    expect(ws.getSnapshot().saveStatus).toBe('saved');
  });

  it('a create the library refuses still loads the content, detached (L6 / F1)', async () => {
    const { ws, editor } = await setup();
    const id = await ws.createAndOpen('no-such-folder', 'demo.json', 'doc:demo', {
      content: { text: 'demo', history: 0 },
    });
    expect(id).toBeNull();
    expect(editor.doc?.text).toBe('demo');
    expect(ws.getSnapshot().detached).toBe(true);
    expect(ws.getSnapshot().editorOpen).toBe(true);
  });

  it('"Save to library" creates and attaches WITHOUT reinstalling the editor (L16)', async () => {
    const { ws, library, editor, clock } = await setup();
    editor.doc = { text: 'shown', history: 3 };
    const id = await ws.createAndOpen(library.tree.rootId, 'shown.json', 'doc:shown');
    expect(id).not.toBeNull();
    expect(editor.log.filter((entry) => entry.startsWith('install'))).toEqual([]);
    expect(editor.doc.history).toBe(3);
    expect(ws.getSnapshot().activeFileId).toBe(id);
    ws.contentChanged();
    await clock.runAll();
    expect(ws.getSnapshot().saveStatus).toBe('saved'); // same content: clean
  });
});

describe('Workspace — tabs of other kinds, preview, read-only', () => {
  it('non-file tabs (welcome, share) coexist with file tabs', async () => {
    const closing: (readonly string[])[] = [];
    let allowClose = false;
    const { ws, ids, open, editor } = await setup({
      files: { 'a.json': 'doc:A' },
      beforeCloseTabs: async (tabs) => {
        closing.push(tabs);
        return allowClose;
      },
    });
    expect(ws.getSnapshot().tabs.order).toEqual([WELCOME]); // first visit
    await open(ids['a.json']);
    await ws.openTab(SHARE);
    expect(editor.doc).toBeNull(); // the app renders the share tab
    expect(ws.getSnapshot().editorOpen).toBe(false);
    expect(ws.label(SHARE)).toBe('Stream p1');
    expect(ws.label(WELCOME)).toBe('Welcome');
    expect(ws.isDirty(SHARE)).toBe(false);
    expect(ws.isTabMissing(SHARE)).toBe(false);

    await ws.activateTab(fileTab(ids['a.json']));
    expect(editor.log.at(-1)).toBe('restore:A');
    expect(ws.getSnapshot().activeFileId).toBe(ids['a.json']);

    await ws.closeTabs([SHARE]);
    expect(closing).toEqual([[SHARE]]);
    expect(ws.getSnapshot().tabs.order).toContain(SHARE); // refused
    allowClose = true;
    await ws.closeTabs([SHARE, WELCOME]);
    expect(ws.getSnapshot().tabs.order).toEqual([fileTab(ids['a.json'])]);
  });

  it('a preview open replaces the previous preview; an edit makes it permanent', async () => {
    const { ws, ids, edit, open, clock } = await setup({
      files: { 'a.json': 'doc:A', 'b.json': 'doc:B', 'c.json': 'doc:C' },
    });
    const [a, b, c] = [ids['a.json'], ids['b.json'], ids['c.json']];
    await open(a, { preview: true });
    await open(b, { preview: true });
    expect(ws.getSnapshot().tabs.order).toEqual([WELCOME, fileTab(b)]);
    expect(ws.getSnapshot().tabs.preview).toBe(fileTab(b));
    edit('B edited');
    await clock.fire(300);
    expect(ws.getSnapshot().tabs.preview).toBeNull(); // promoted
    await open(c, { preview: true });
    expect(ws.getSnapshot().tabs.order).toEqual([WELCOME, fileTab(b), fileTab(c)]);
    ws.promoteTab(fileTab(c));
    expect(ws.getSnapshot().tabs.preview).toBeNull();
  });

  it('a read-only linked folder never saves', async () => {
    const store = createMemoryStore();
    const library = new FileLibrary({ store, policy, access: 'read' });
    const { ws, id, edit, open, clock, root } = await setupFolder({ 'a.json': 'doc:A' }, { store, library });
    await open(id('a.json'));
    expect(ws.getSnapshot().readOnly).toBe(true);
    expect(ws.getSnapshot().saveStatus).toBe('unavailable');
    edit('A edited');
    await ws.saveNow();
    await clock.runAll();
    expect(await readDisk(root, 'a.json')).toBe('doc:A');
  });

  it('a video app: binary files open through getFile, never read as text, never saved', async () => {
    const store = createMemoryStore();
    const library = new FileLibrary({ store, policy: videoPolicy });
    await library.init();
    const readText = vi.spyOn(library, 'readText');
    let playing: File | null = null;
    const player: DocumentAdapter<File> = {
      async load(file) {
        const blob = await file.getFile();
        return { ok: true, content: blob, signature: `${blob.size}` };
      },
      install(content) {
        playing = content;
      },
      closeEditor() {
        playing = null;
      },
    };
    const ws = new Workspace<File>({ library, kinds, documents: player, timers: manualTimers().timers });
    await ws.boot();
    const movie = await library.createFile(library.tree.rootId, 'movie.mp4', new Blob([new Uint8Array(64)]));
    const other = await library.createFile(library.tree.rootId, 'other.mp4', new Blob([new Uint8Array(8)]));
    expect(ws.saveController).toBeNull();
    await ws.openFile(movie, { preview: true });
    expect(playing!.size).toBe(64);
    await ws.openFile(other, { preview: true });
    expect(playing!.size).toBe(8);
    expect(ws.getSnapshot().tabs.order).toEqual([fileTab(other)]);
    expect(ws.getSnapshot().activeFileId).toBe(other);
    expect(ws.getSnapshot().saveStatus).toBe('unavailable');
    expect(readText).not.toHaveBeenCalled();
  });
});

describe('Workspace — sessions', () => {
  it('the tab record persists and restores across a new Workspace on the same store', async () => {
    const store = createMemoryStore();
    const first = await setup({ store, files: { 'a.json': 'doc:A', 'b.json': 'doc:B' } });
    await first.ws.openTab(SHARE);
    await first.open(first.ids['a.json']);
    await first.open(first.ids['b.json']);
    expect(first.ws.getSnapshot().tabs.order).toEqual([
      WELCOME,
      SHARE,
      fileTab(first.ids['a.json']),
      fileTab(first.ids['b.json']),
    ]);
    await first.clock.runAll(); // the debounced record is written
    first.ws.dispose();

    const opened: number[] = [];
    const second = await setup({ store, onStartupOpened: (count) => opened.push(count) });
    const state = second.ws.getSnapshot();
    // The share tab is not persisted; files come back by path.
    expect(state.tabs.order).toEqual([
      WELCOME,
      fileTab(first.ids['a.json']),
      fileTab(first.ids['b.json']),
    ]);
    expect(state.tabs.active).toBe(fileTab(first.ids['b.json']));
    expect(second.editor.doc?.text).toBe('B'); // only the active tab loaded
    expect(state.recentFiles).toEqual([first.ids['b.json'], first.ids['a.json']]);
    expect(opened).toEqual([2]); // Q7
  });

  it('adopts the boot journal, marking it unsaved only when its CONTENT differs (B4)', async () => {
    const store = createMemoryStore();
    const first = await setup({ store, files: { 'a.json': 'doc:A' } });
    first.ws.dispose();

    const journal = memoryJournal({ path: ['a.json'], text: 'doc:A' });
    const same = await setup({ store, journal });
    expect(same.ws.getSnapshot().activeFileId).toBe(first.ids['a.json']);
    expect(same.ws.getSnapshot().saveStatus).toBe('saved');
    same.ws.dispose();

    const newer = memoryJournal({ path: ['a.json'], text: 'doc:newer' });
    const fake = fakeEditor();
    fake.editor.doc = { text: 'newer', history: 0 }; // the app restored it at boot
    const adopted = await setup({ store, journal: newer, adapter: fake.adapter });
    expect(adopted.ws.getSnapshot().saveStatus).toBe('unsaved');
    await adopted.clock.runAll();
    expect(await adopted.read(first.ids['a.json'])).toBe('doc:newer');
  });

  it('content loaded before boot finished makes the journal unadoptable (B2 / B3)', async () => {
    const store = createMemoryStore();
    const first = await setup({ store, files: { 'a.json': 'doc:A' } });
    first.ws.dispose();
    const journal = memoryJournal({ path: ['a.json'], text: 'doc:journal' });
    const context = await setup({ store, journal, boot: false });
    // A demo clicked while the library is still loading.
    await context.ws.createAndOpen(context.library.tree.rootId, 'demo.json', 'doc:demo', {
      content: { text: 'demo', history: 0 },
    });
    await context.ws.boot();
    await context.clock.runAll();
    expect(context.ws.getSnapshot().activeFileId).toBeNull();
    expect(await context.read(first.ids['a.json'])).toBe('doc:A');
    expect(context.editor.doc?.text).toBe('demo');
  });

  it('the journal is written while a writable file is open, and cleared when nothing is', async () => {
    const journal = memoryJournal(null);
    const { ws, ids, edit, open, clock } = await setup({ files: { 'a.json': 'doc:A' }, journal });
    await open(ids['a.json']);
    edit('A edited');
    ws.flushJournal(); // pagehide
    expect(journal.entry).toEqual({ path: ['a.json'], text: 'doc:A edited' });
    await ws.closeTabs([fileTab(ids['a.json'])]);
    expect(journal.entry).toBeNull();
    await clock.runAll();
  });

  it('detach (a loan) settles the file, writes nothing shown meanwhile, and showTab brings it back', async () => {
    const { ws, ids, edit, open, read, clock, editor } = await setup({ files: { 'a.json': 'doc:A' } });
    await open(ids['a.json']);
    edit('A edited');
    await ws.detach();
    expect(await read(ids['a.json'])).toBe('doc:A edited'); // settled
    editor.doc = { text: 'piano', history: 0 }; // the app borrows the editor
    ws.contentChanged();
    await clock.runAll();
    expect(await read(ids['a.json'])).toBe('doc:A edited');
    await ws.reattach();
    expect(editor.doc?.text).toBe('A edited');
    expect(editor.doc?.history).toBe(1);
    expect(ws.getSnapshot().activeFileId).toBe(ids['a.json']);
  });

  it('freeze (a probe): nothing is written for the rest of the session', async () => {
    const { ws, ids, open, read, clock, editor, store } = await setup({ files: { 'a.json': 'doc:A' } });
    await open(ids['a.json']);
    await clock.runAll();
    const recordBefore = await store.get('openTabs');
    await ws.freeze();
    editor.doc = { text: 'probe', history: 0 };
    ws.contentChanged();
    await ws.openTab(SHARE);
    await clock.runAll();
    expect(await read(ids['a.json'])).toBe('doc:A');
    expect(await store.get('openTabs')).toEqual(recordBefore);
    expect(ws.getSnapshot().readOnly).toBe(true);
    expect(await ws.unlink()).toBe(false);
  });

  it('a read-only session (?nosave) never writes the tab record or the file', async () => {
    const store = createMemoryStore();
    const seed = await setup({ store, files: { 'a.json': 'doc:A' } });
    seed.ws.dispose();
    await store.delete('openTabs');
    const { ws, ids, edit, open, read, clock } = await setup({ store, readOnly: true });
    const a = findByPath(ws.library.tree, ['a.json'])!.id;
    void ids;
    await open(a);
    edit('A edited');
    await clock.runAll();
    expect(await read(a)).toBe('doc:A');
    expect(await store.get('openTabs')).toBeUndefined();
  });
});

function memoryJournal(entry: JournalEntry | null): Journal & { entry: JournalEntry | null } {
  const boot = entry?.path ?? null;
  return {
    entry,
    save(next) {
      this.entry = next;
    },
    load() {
      return this.entry;
    },
    clear() {
      this.entry = null;
    },
    bootPath: () => boot,
  };
}
