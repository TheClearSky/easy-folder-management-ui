/**
 * Saving the OPEN file, and only the open file.
 *
 * THE BUG THIS EXISTS TO PREVENT. The app's autosave used to be a timer that,
 * 800 ms after an edit, wrote "the current project" to one fixed slot. With
 * one slot that was harmless. With files it is a data-loss bug: edit file A,
 * click file B within 800 ms, and the timer fires after B has loaded —
 * writing B's graph into A, or A's into B, depending on which side captured
 * what (research/2026-09-26-file-library/app-integration.md, risk 1).
 *
 * The rules:
 *  1. A save is addressed by FILE ID, captured when the timer is armed, and
 *     a timer only fires if that file is still the open one (a generation
 *     counter retires timers armed for a file that was switched away from).
 *  2. Switching files first settles the file being left: saved (auto-save
 *     on) or kept as an in-memory buffer shown as unsaved (auto-save off).
 *  3. Nothing is saved to a file that is not writable — an unsupported file,
 *     a probe graph, a folder awaiting reconnection.
 *
 * Auto-save is configurable like auto-run (ruling F3: "same as autorun
 * configurable"): on/off and a delay. Off means Ctrl+S / Save now.
 *
 * Framework-free and timer-injectable so the rules above are tested directly.
 */

type SaveSettings = { enabled: boolean; delaySeconds: number };

type SaveControllerDependencies = {
  /** The project as it is right now, as file text. */
  serialize(): string;
  write(fileId: string, text: string, options?: { force?: boolean }): Promise<void>;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
};

/** Below this, a slider drag would write a 0.6-0.86 MB file per frame. */
const MINIMUM_SAVE_DELAY_MS = 300;

class SaveController {
  private active: string | null = null;
  private activeWritable = false;
  private dirty = false;
  private readonly buffers = new Map<string, string>();
  private timer: unknown = undefined;
  private generation = 0;
  private settings: SaveSettings = { enabled: true, delaySeconds: 0.8 };
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly deps: SaveControllerDependencies) {}

  // ── observation ──────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever anything observable changes (for useSyncExternalStore). */
  getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  get activeFileId(): string | null {
    return this.active;
  }

  get isActiveWritable(): boolean {
    return this.active !== null && this.activeWritable;
  }

  getSettings(): SaveSettings {
    return this.settings;
  }

  /** Unsaved edits in `fileId` — the open one or a buffered one. */
  isDirty(fileId: string): boolean {
    return (fileId === this.active && this.dirty) || this.buffers.has(fileId);
  }

  /** Anything at all that is not in its file yet. */
  hasUnsavedWork(): boolean {
    return this.dirty || this.buffers.size > 0;
  }

  /**
   * What a closing tab would actually LOSE: unsaved edits of files that are
   * not open. The open file's pending edit is not in this set — the journal
   * (a synchronous localStorage copy written on `pagehide`) carries it into
   * the next session, where it reopens as unsaved.
   */
  hasBufferedFiles(): boolean {
    return this.buffers.size > 0;
  }

  /** Pending (armed) auto-save, for the toolbar. */
  get isPending(): boolean {
    return this.timer !== undefined;
  }

  // ── edits ────────────────────────────────────────────────────────────

  /** The project changed. Arms an auto-save for THIS file. */
  markChanged(): void {
    if (!this.isActiveWritable) return;
    if (!this.dirty) {
      this.dirty = true;
      this.notify();
    }
    if (this.settings.enabled) this.arm();
  }

  private arm(): void {
    // Re-arming an already pending save changes nothing observable, so it
    // must not notify: every drag frame of an edit re-arms, and a notify here
    // re-rendered the whole app once more per frame (J1).
    const wasPending = this.timer !== undefined;
    this.cancelTimer();
    const fileId = this.active;
    const generation = this.generation;
    const delayMs = Math.max(MINIMUM_SAVE_DELAY_MS, this.settings.delaySeconds * 1000);
    this.timer = (this.deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms)))(() => {
      this.timer = undefined;
      // Rule 1: never write a file that is no longer the open one.
      if (fileId !== this.active || generation !== this.generation) return;
      void this.save().catch(() => {});
    }, delayMs);
    if (!wasPending) this.notify();
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    (this.deps.clearTimer ?? ((handle) => clearTimeout(handle as number)))(this.timer);
    this.timer = undefined;
  }

  /**
   * Save the open file now (Ctrl+S, Save now, or the auto-save timer).
   * The content is serialised at this instant and the target is the file
   * open at this instant — both captured before the first await.
   */
  async save(options?: { force?: boolean }): Promise<void> {
    this.cancelTimer();
    if (!this.isActiveWritable || !this.dirty) {
      this.notify();
      return;
    }
    const fileId = this.active as string;
    const text = this.deps.serialize();
    this.dirty = false;
    this.notify();
    try {
      await this.deps.write(fileId, text, options);
    } catch (error) {
      // Still unsaved — unless the user has since left the file, in which
      // case keep what we tried to write as its buffer.
      if (this.active === fileId) this.dirty = true;
      else this.buffers.set(fileId, text);
      this.notify();
      throw error;
    }
  }

  /**
   * Settle the open file before something moves, renames or deletes it:
   * with auto-save on, write now; with it off, leave it dirty (the edit
   * follows the file by id).
   */
  async flush(): Promise<void> {
    if (this.dirty && this.settings.enabled) await this.save();
  }

  // ── switching ────────────────────────────────────────────────────────

  /**
   * Make `fileId` the open file (null: none). The file being left is saved
   * or buffered FIRST, while the app still shows its content — call this
   * BEFORE installing the next project.
   */
  async switchTo(fileId: string | null, writable: boolean): Promise<void> {
    this.cancelTimer();
    this.generation += 1;
    const leaving = this.active;
    if (leaving !== null && leaving !== fileId && this.dirty && this.activeWritable) {
      // Serialise NOW, while the app still shows the file being left.
      const text = this.deps.serialize();
      if (this.settings.enabled) {
        try {
          await this.deps.write(leaving, text);
        } catch {
          // Not lost: kept as the file's unsaved buffer, shown with a dot.
          // (Going through `save()` here would be wrong — it would see the
          // file still open, mark it dirty, and the reset below would then
          // discard the edit.)
          this.buffers.set(leaving, text);
        }
      } else {
        this.buffers.set(leaving, text);
      }
    }
    this.active = fileId;
    this.activeWritable = writable;
    this.dirty = false;
    this.notify();
  }

  /**
   * Write a NOT-open file's buffered edits (closing its tab with "Save").
   * The buffer goes only once the write succeeds; a failure keeps it and
   * rethrows, so the caller can keep the tab open.
   */
  async saveBuffered(fileId: string): Promise<void> {
    const text = this.buffers.get(fileId);
    if (text === undefined) return;
    await this.deps.write(fileId, text);
    if (this.buffers.get(fileId) === text) this.buffers.delete(fileId);
    this.notify();
  }

  /** Unsaved content kept for `fileId` since it was switched away from. The
   *  caller opens from it and then calls `markChanged` so it shows as unsaved. */
  takeBuffer(fileId: string): string | undefined {
    const text = this.buffers.get(fileId);
    this.buffers.delete(fileId);
    if (text !== undefined) this.notify();
    return text;
  }

  /** Put back a buffer that was taken for an open that got superseded, so a
   *  second quick click does not throw the unsaved edit away (C2). Never
   *  replaces a buffer made since. */
  restoreBuffer(fileId: string, text: string): void {
    if (this.buffers.has(fileId) || fileId === this.active) return;
    this.buffers.set(fileId, text);
    this.notify();
  }

  /** Files that no longer exist lose their buffers; the open one closes. */
  forget(fileIds: readonly string[]): void {
    let changed = false;
    for (const id of fileIds) changed = this.buffers.delete(id) || changed;
    if (this.active !== null && fileIds.includes(this.active)) {
      this.cancelTimer();
      this.generation += 1;
      this.active = null;
      this.activeWritable = false;
      this.dirty = false;
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Allow or forbid writes to the open file (reconnect, probe). */
  setWritable(writable: boolean): void {
    if (this.activeWritable === writable) return;
    this.activeWritable = writable;
    if (!writable) this.cancelTimer();
    else if (this.dirty && this.settings.enabled) this.arm();
    this.notify();
  }

  // ── settings ─────────────────────────────────────────────────────────

  /**
   * Turning auto-save ON writes everything unsaved right away — the open
   * file and every buffered one — because "auto-save is on" must mean
   * "nothing is unsaved", not "the next edit will be saved".
   */
  async setSettings(next: SaveSettings): Promise<void> {
    const wasEnabled = this.settings.enabled;
    this.settings = next;
    this.notify();
    if (!next.enabled) {
      this.cancelTimer();
      return;
    }
    if (!wasEnabled) {
      for (const [fileId, text] of [...this.buffers]) {
        try {
          await this.deps.write(fileId, text);
          this.buffers.delete(fileId);
        } catch {
          // Leave it buffered and visible as unsaved.
        }
      }
      this.notify();
      if (this.dirty) await this.save().catch(() => {});
    } else if (this.dirty) {
      this.arm(); // a new delay applies to the pending save
    }
  }
}

export { MINIMUM_SAVE_DELAY_MS, SaveController };
export type { SaveSettings };
