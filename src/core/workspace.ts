/**
 * The workspace: which tabs are open, which file the editor shows, how a
 * file opens, when it saves, and how the library's operations stay
 * consistent with the editor.
 *
 * Framework-free (subscribe / getSnapshot for `useSyncExternalStore`), so
 * every rule is tested in Node. It is the generic half of Nodestra's
 * `useLibrarySession` hook; everything app-specific sits behind a
 * `DocumentAdapter` (parse, show, capture, serialise) and a few callbacks.
 *
 * ONE EDITOR, MANY TABS. The app has a single editor that the workspace
 * swaps between documents: the document being left is captured (an
 * in-memory snapshot, e.g. with its undo history), the next one is loaded
 * or restored. Tabs that are NOT files (`welcome:`, `share:<id>`) are only
 * opened, activated and closed here; the app renders them, and the editor
 * is closed while one is active.
 *
 * The pieces it wires together:
 *  - FileLibrary    — the tree and its storage
 *  - SaveController — saves the OPEN file by id (only when the adapter can
 *    serialise; a read-only app has none)
 *  - tabsReducer    — the strip, as pure data
 *  - TabRecordStore — the strip across reloads
 *
 * Fix ids in the comments (A1, C1, C2, B2–B10, D2, E1, E3, E6, FB-28, L6,
 * L11, L16, L23…) refer to Nodestra's review/2026-09-26-library/TRIAGE.md,
 * where each was found and live-verified. W1–W3 are fixes made while
 * porting (no review id): see the comments where they apply.
 *
 * Prompts are never made here: `confirm`, `chooseUnlink` and
 * `confirmUnsaved` are injected.
 */

import { ConflictError } from './backends';
import type { FolderAccess, WriteData } from './backends';
import type { FileLibrary, LibrarySnapshot, UnlinkPlan, UnlinkProgress } from './fileLibrary';
import { findByPath, isOpenableFile, pathOf, subtreeIds } from './libraryTree';
import type { LibraryNode, LibraryTree } from './libraryTree';
import { SaveController } from './saveController';
import type { SaveSettings } from './saveController';
import { parseTabId, tabId } from './tabKinds';
import type { TabId, TabKinds } from './tabKinds';
import { createTabRecordStore } from './tabRecord';
import type { TabRecordStore } from './tabRecord';
import { activeAfterClose, emptyTabs, othersOf, rightOf, tabsReducer } from './tabsModel';
import type { TabsAction, TabsState } from './tabsModel';

// ── the adapter ──────────────────────────────────────────────────────────

/** A library file being opened, as the adapter sees it. */
type DocumentFile = {
  /** The file's stable library id. */
  id: string;
  node: LibraryNode;
  /** The content is this session's UNSAVED buffer of the file (auto-save
   *  off, switched away from), not what storage holds. */
  buffered: boolean;
  /** The file as a `File`. From a linked folder this is the browser's
   *  disk-backed file: `URL.createObjectURL` streams it without reading it. */
  getFile(): Promise<File>;
  /** The whole file as text (or the unsaved buffer). Read at most once. */
  readText(): Promise<string>;
};

type LoadResult<Content> =
  | {
      ok: true;
      content: Content;
      /** The file opened, but with repairs: its original bytes are handed to
       *  `onFirstSaveOfWarnedFile` before the first save overwrites them. */
      warnings?: readonly string[];
      /** What the FILE says, for snapshot reuse. Defaults to
       *  `signature(text)` when the adapter read the text, else `null`
       *  (never reuse). A binary adapter can pass e.g. `lastModified:size`. */
      signature?: string | null;
    }
  /** Not a document this app opens: "Unsupported file" is shown instead
   *  of the editor, the file is never written, and nothing else is blocked. */
  | { ok: false; detail: string };

/**
 * The app's documents. Only `load`, `install` and `closeEditor` are
 * required; a read-only app (a video player) stops there.
 */
interface DocumentAdapter<Content, Snapshot = never> {
  /** Parse a file. A throw is shown like a refusal, as a read failure. */
  load(file: DocumentFile): Promise<LoadResult<Content>>;
  /** Show freshly loaded content in the editor. */
  install(content: Content): void;
  /** Nothing is open (or a non-file tab is active): empty the editor. */
  closeEditor(): void;
  /** "Unsupported file" is about to be shown over the previous document:
   *  stop whatever it was doing (audio, playback). */
  silence?(): void;
  /** The editor's current document, kept in memory while another tab is
   *  shown (with its undo history, viewport…). Never written anywhere. */
  capture?(): Snapshot;
  /** Show a kept snapshot again. */
  restore?(snapshot: Snapshot): void;
  /** The editor's document as file text. Present ⇒ the workspace saves. */
  serialize?(): string;
  /** Content identity of file text, ignoring transient parts (timestamps,
   *  viewport). Defaults to the text itself. Drives change detection (C1)
   *  and snapshot reuse. */
  signature?(text: string): string | null;
  /** The first save of a file that opened with warnings is about to
   *  overwrite `original`. Throwing fails that save, so the edit stays
   *  unsaved and the backup is never silently dropped (B10). Nodestra
   *  writes a `"<name> (original).json"` sibling here. */
  onFirstSaveOfWarnedFile?(
    original: string,
    file: { id: string; node: LibraryNode; library: FileLibrary },
  ): Promise<void>;
}

// ── options and state ────────────────────────────────────────────────────

/** A crash copy of the OPEN file, per browser tab (Nodestra keeps it in
 *  `sessionStorage`). Path and text are ONE entry (B7), per tab (B6). */
type JournalEntry = { path: readonly string[]; text: string };

interface Journal {
  /** Synchronous: it is also called from `pagehide`. */
  save(entry: JournalEntry): void;
  load(): JournalEntry | null;
  clear(): void;
  /** The path whose journal the app restored into the editor at boot, or
   *  `null`. Only such a journal may be adopted (B2/B3). */
  bootPath(): readonly string[] | null;
}

/** What `confirm` is asked. The app words it. (Unlinking has its own
 *  three-way prompt, `chooseUnlink`.) */
type ConfirmRequest =
  /** Linking replaces a non-empty in-browser library (its files are deleted
   *  from the browser). */
  | { kind: 'link'; folderName: string; openable: number; folders: number }
  | {
      kind: 'delete';
      /** `"name"` or `N items`. */
      label: string;
      /** Deleted from the disk, not just the browser. */
      onDisk: boolean;
      openable: number;
      /** Files inside that are not openable. */
      otherFiles: number;
      /** Entries the tree does not show (`.git`) that go too. */
      hidden: number;
      /** Files `undoDelete()` can NOT bring back (the policy's `keepForUndo`
       *  refuses them — every binary file by default). `0` means the whole
       *  delete can be undone until the page is reloaded. */
      permanent: number;
    };

/** UNLINK: copy the folder into the browser (`'keep'`), end up with an empty
 *  in-browser library (`'remove'`), or do nothing. */
type UnlinkChoice = 'keep' | 'remove' | 'cancel';

type UnsavedChoice = 'save' | 'discard' | 'cancel';

type TimerApi = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

interface WorkspaceOptions<Content, Snapshot = never> {
  library: FileLibrary;
  kinds: TabKinds;
  documents: DocumentAdapter<Content, Snapshot>;
  /** The kind whose tabs are library files. Default: the kind that
   *  persists `'file'`, else `'file'`. */
  fileKind?: string;
  /** Initial auto-save settings, or `false` to never save even though the
   *  adapter can serialise. Default `{ enabled: true, delaySeconds: 0.8 }`. */
  save?: SaveSettings | false;
  /** Nothing is ever written: no saves, no tab record, no journal, no
   *  link/unlink/reconnect (Nodestra's `?nosave`). */
  readOnly?: boolean;
  journal?: Journal;
  /** Remember the strip across reloads (default true). */
  persistTabs?: boolean;
  /** The page opened on a first visit, and on later visits that restore
   *  nothing (when `startup.showWelcomeOnStartup` allows). */
  welcomeTab?: TabId;
  /** Closing tabs with unsaved edits. Without it, closing SAVES first
   *  (the choice that cannot lose anything). */
  confirmUnsaved?(names: readonly string[]): Promise<UnsavedChoice>;
  /** Destructive library operations. Without it, they proceed. */
  confirm?(request: ConfirmRequest): Promise<boolean>;
  /** UNLINK: KEEP a copy in the browser, REMOVE, or cancel — shown with the
   *  measured plan (sizes, free space, whether it fits). Without it, unlink
   *  KEEPs (or forgets a folder awaiting reconnection). */
  chooseUnlink?(plan: UnlinkPlan): Promise<UnlinkChoice>;
  /** Closing non-file tabs (e.g. "Stop watching this stream?"). `false`
   *  cancels the whole close. */
  beforeCloseTabs?(ids: readonly TabId[]): Promise<boolean>;
  /** Labels of non-file tabs. */
  label?(tab: { id: TabId; kind: string; key: string }): string | undefined;
  /** May a closed non-file tab be reopened? Default yes. */
  canReopen?(id: TabId): boolean;
  startup?: {
    /** First visit ever: bring older work into the library (e.g. with
     *  `createAndOpen`). Resolve `true` when something was opened. */
    migrateFirstVisit?(): Promise<boolean>;
    /** First visit, nothing migrated (Nodestra offers its tutorial, Q14). */
    onFirstVisit?(): void;
    /** Startup opened files on its own: restored tabs, an adopted journal,
     *  migrated work (Nodestra turns auto-run off and says so, Q7). */
    onStartupOpened?(count: number): void;
    /** Default true. */
    showWelcomeOnStartup?(): boolean;
  };
  /** Recently opened files kept (default 8). */
  maxRecent?: number;
  /** Injectable clock (tests). */
  timers?: TimerApi;
}

/** Why the editor shows "Unsupported file" (or "could not be read"). */
type OpenFailure = {
  fileId: string;
  name: string;
  detail: string;
  /** `'unsupported'`: the adapter refused it; `'read'`: reading failed. */
  reason: 'unsupported' | 'read';
};

/** A linked file changed on disk outside the app; saving it is paused
 *  until the user picks Overwrite or Reload (D2: never a timer-driven
 *  confirm). */
type SaveConflict = { fileId: string; name: string };

type SaveStatus = 'saved' | 'unsaved' | 'unavailable';

type WorkspaceSnapshot = {
  library: LibrarySnapshot;
  tabs: TabsState;
  /** The library file the editor is attached to (saves go here). */
  activeFileId: string | null;
  activeFileName: string | null;
  openFailure: OpenFailure | null;
  conflict: SaveConflict | null;
  /** The editor shows content that is not attached to a library file (a
   *  failed create, a loan, a deleted file's last copy). */
  detached: boolean;
  /** `freeze()` was called: nothing is written for the rest of the session. */
  frozen: boolean;
  /** Recently opened files that still exist, newest first. */
  recentFiles: readonly string[];
  /** Tree changes are refused (read-only session, frozen, read-only link,
   *  reconnect pending). */
  readOnly: boolean;
  /** Link / Unlink / Reconnect are refused. */
  folderActionsDisabled: boolean;
  saveStatus: SaveStatus;
  savePending: boolean;
  /** `null` when the workspace never saves. */
  autoSave: SaveSettings | null;
  /** The editor has something to show: a file tab, or detached content. */
  editorOpen: boolean;
};

type KeptSnapshot<Snapshot> = {
  snapshot: Snapshot;
  /** What the FILE said (its signature) when this copy was taken. The copy
   *  is reused only while the file still says that — compared file to file,
   *  never copy to file, because loading may normalise content so a copy
   *  never serialises byte-for-byte like its file. */
  fileSignature: string | null;
};

/** How long edits must settle before "did the content change?" is asked
 *  (a drag emits a change per frame; serialising per frame stutters). */
const CHANGE_SETTLE_MS = 300;
/** The journal's own debounce. */
const JOURNAL_DELAY_MS = 800;
/** The tab record's debounce. */
const TAB_RECORD_DELAY_MS = 300;
const DEFAULT_MAX_RECENT = 8;

const defaultTimers: TimerApi = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

class Workspace<Content = unknown, Snapshot = never> {
  readonly library: FileLibrary;
  readonly kinds: TabKinds;
  /** The kind whose tabs are library files. */
  readonly fileKind: string;
  /** `null` when the adapter cannot serialise (or `save: false`). */
  readonly saveController: SaveController | null;

  private readonly adapter: DocumentAdapter<Content, Snapshot>;
  private readonly options: WorkspaceOptions<Content, Snapshot>;
  private readonly timers: TimerApi;
  private readonly records: TabRecordStore;
  private readonly maxRecent: number;

  private tabsState: TabsState = emptyTabs;
  /** The open file when there is no SaveController (it tracks its own). */
  private openId: string | null = null;
  /** The file whose content the editor ACTUALLY shows. Differs from the
   *  open file while an open is in flight or "Unsupported" is shown. */
  private shown: string | null = null;
  private failure: OpenFailure | null = null;
  private conflictState: SaveConflict | null = null;
  private detachedState = false;
  private frozenState = false;
  private recent: string[] = [];
  private readonly snapshots = new Map<string, KeptSnapshot<Snapshot>>();
  /** Content signature of each file as last read or written by the app. */
  private readonly fileSignatures = new Map<string, string | null>();
  /** Last name of each file tab: a file deleted outside the app keeps its
   *  tab (shown missing) and its label. */
  private readonly tabNames = new Map<string, string>();
  /** Original text of files that opened with warnings, until backed up. */
  private readonly originals = new Map<string, string>();
  /** Signature of what storage holds for the open file (C1). `null` until
   *  the first settle after an install. */
  private baseline: string | null = null;
  private installing = false;
  private openToken = 0;
  /** The editor still shows the journal it restored at boot; any
   *  user-driven load ends that, and the journal must not be adopted after
   *  (B2/B3). */
  private bootJournalValid = true;
  private bootPromise: Promise<void> | null = null;
  /** A buffer taken for an open that then failed (W3): given back as soon
   *  as the editor leaves that file. */
  private heldBuffer: { fileId: string; text: string } | null = null;
  /** The snapshot `captureActive` took for the switch about to happen. */
  private lastCapture: { fileId: string; entry: KeptSnapshot<Snapshot> } | null = null;

  private settleTimer: unknown = undefined;
  private journalTimer: unknown = undefined;
  private recordTimer: unknown = undefined;

  private lastTree: LibraryTree;
  private lastModeKind: string;
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: (() => void)[] = [];
  private state: WorkspaceSnapshot;

  constructor(options: WorkspaceOptions<Content, Snapshot>) {
    this.options = options;
    this.library = options.library;
    this.kinds = options.kinds;
    this.adapter = options.documents;
    this.timers = options.timers ?? defaultTimers;
    this.maxRecent = options.maxRecent ?? DEFAULT_MAX_RECENT;
    this.fileKind =
      options.fileKind ??
      Object.keys(options.kinds).find((name) => options.kinds[name].persist === 'file') ??
      'file';
    this.records = createTabRecordStore({ library: options.library, kinds: options.kinds });

    const serialize = this.adapter.serialize?.bind(this.adapter);
    if (options.save !== false && serialize) {
      this.saveController = new SaveController({
        serialize,
        write: (fileId, text, writeOptions) => this.writeFile(fileId, text, writeOptions),
        setTimer: (callback, ms) => this.timers.set(callback, ms),
        clearTimer: (handle) => this.timers.clear(handle),
      });
      if (options.save) void this.saveController.setSettings(options.save);
      this.cleanups.push(this.saveController.subscribe(() => this.emit()));
    } else {
      this.saveController = null;
    }

    // Flush the open file before anything moves, renames or deletes it. The
    // library calls this OUTSIDE its queue: awaiting the save from inside a
    // queued operation deadlocked every later open and save (A1).
    const previousGuard = this.library.beforeMutate;
    this.library.beforeMutate = async (ids) => {
      const active = this.current;
      if (active !== null && ids.includes(active)) {
        this.flushPendingChange();
        await this.saveController?.flush();
      }
      await previousGuard(ids);
    };
    this.cleanups.push(() => {
      this.library.beforeMutate = previousGuard;
    });

    const librarySnapshot = this.library.getSnapshot();
    this.lastTree = librarySnapshot.tree;
    this.lastModeKind = librarySnapshot.mode.kind;
    this.cleanups.push(this.library.subscribe(() => this.onLibraryChange()));
    this.state = this.build();
  }

  // ── store plumbing ────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WorkspaceSnapshot => this.state;

  private emit(): void {
    this.state = this.build();
    for (const listener of this.listeners) listener();
  }

  private build(): WorkspaceSnapshot {
    const library = this.library.getSnapshot();
    const controller = this.saveController;
    const active = this.current;
    const tabs = this.tabsState;
    const saveStatus: SaveStatus =
      !controller || !controller.isActiveWritable
        ? 'unavailable'
        : active !== null && controller.isDirty(active)
          ? 'unsaved'
          : 'saved';
    return {
      library,
      tabs,
      activeFileId: active,
      activeFileName: active === null ? null : (library.tree.nodes[active]?.name ?? null),
      openFailure: this.failure,
      conflict: this.conflictState,
      detached: this.detachedState,
      frozen: this.frozenState,
      recentFiles: this.recent.filter((id) => library.tree.nodes[id]),
      readOnly: this.sessionReadOnly || !this.library.writable,
      folderActionsDisabled: this.sessionReadOnly,
      saveStatus,
      savePending: controller?.isPending ?? false,
      autoSave: controller?.getSettings() ?? null,
      editorOpen: this.detachedState || (tabs.active !== null && this.isFileTab(tabs.active)),
    };
  }

  /** Stop listening to the library and the save controller, cancel timers,
   *  and give the library its own mutation guard back. */
  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const handle of [this.settleTimer, this.journalTimer, this.recordTimer]) {
      if (handle !== undefined) this.timers.clear(handle);
    }
    this.settleTimer = this.journalTimer = this.recordTimer = undefined;
    this.listeners.clear();
  }

  // ── small helpers ─────────────────────────────────────────────────────

  /** The library file the editor is attached to. */
  private get current(): string | null {
    return this.saveController ? this.saveController.activeFileId : this.openId;
  }

  private get sessionReadOnly(): boolean {
    return this.options.readOnly === true || this.frozenState;
  }

  /** May the open file be written right now? */
  private writable(): boolean {
    return this.library.writable && !this.sessionReadOnly;
  }

  /** The tab id of a library file. */
  fileTabId(fileId: string): TabId {
    return tabId(this.fileKind, fileId);
  }

  /** The library file behind a tab, or `null` for a non-file tab. */
  fileIdOf(id: TabId): string | null {
    const parsed = parseTabId(id);
    return parsed && parsed.kind === this.fileKind ? parsed.key : null;
  }

  private isFileTab(id: TabId): boolean {
    return this.fileIdOf(id) !== null;
  }

  private fileIdsOf(ids: readonly TabId[]): string[] {
    return ids.map((id) => this.fileIdOf(id)).filter((key): key is string => key !== null);
  }

  private signatureOf(text: string): string | null {
    return this.adapter.signature ? this.adapter.signature(text) : text;
  }

  private dispatchTabs(action: TabsAction): void {
    const next = tabsReducer(this.tabsState, action);
    if (next === this.tabsState) return;
    const before = this.tabsState;
    this.tabsState = next;
    // A preview tab replaced by the next preview never comes back: its
    // snapshot goes with it.
    if (action.type === 'open') {
      for (const id of before.order) {
        const fileId = this.fileIdOf(id);
        if (fileId !== null && !next.order.includes(id)) {
          this.snapshots.delete(fileId);
        }
      }
    }
    this.scheduleTabRecord();
    this.emit();
  }

  private noteRecent(fileId: string): void {
    this.recent = [fileId, ...this.recent.filter((id) => id !== fileId)].slice(0, this.maxRecent);
    this.scheduleTabRecord();
  }

  /** Put content in the editor. Its baseline is taken once the editor has
   *  settled (its own first measurement must not count as an edit, C1), and
   *  change notifications during the install itself are ignored. */
  private installContent(run: () => void): void {
    this.baseline = null;
    this.clearSettle();
    this.installing = true;
    try {
      run();
    } finally {
      this.installing = false;
    }
    // The baseline settles even for an editor that reports no change of its
    // own after an install (Nodestra's always did: measurement, fitView).
    this.armSettle();
  }

  private armSettle(): void {
    this.clearSettle();
    this.settleTimer = this.timers.set(() => {
      this.settleTimer = undefined;
      this.compareNow();
    }, CHANGE_SETTLE_MS);
  }

  private async switchTo(fileId: string | null, writable: boolean): Promise<void> {
    const leaving = this.current;
    const capture = this.lastCapture;
    this.lastCapture = null;
    const signatureBefore = leaving === null ? undefined : this.fileSignatures.get(leaving);
    if (this.saveController) await this.saveController.switchTo(fileId, writable);
    else this.openId = fileId;
    // W4: the switch just saved the file being left — from the very content
    // the snapshot taken right before it holds (the controller serialises
    // synchronously, before its first await). The snapshot therefore still
    // matches the file; without this, its pre-save signature made the
    // return trip reinstall from disk and lose the undo history.
    if (
      leaving !== null &&
      capture !== null &&
      capture.fileId === leaving &&
      this.snapshots.get(leaving) === capture.entry &&
      this.fileSignatures.get(leaving) !== signatureBefore
    ) {
      capture.entry.fileSignature = this.fileSignatures.get(leaving) ?? null;
    }
    const held = this.heldBuffer;
    if (held && held.fileId !== fileId) {
      this.heldBuffer = null;
      this.saveController?.restoreBuffer(held.fileId, held.text);
    }
  }

  private forget(fileIds: readonly string[]): void {
    this.saveController?.forget(fileIds);
    if (!this.saveController && this.openId !== null && fileIds.includes(this.openId)) {
      this.openId = null;
    }
    if (this.heldBuffer && fileIds.includes(this.heldBuffer.fileId)) this.heldBuffer = null;
    for (const id of fileIds) this.originals.delete(id);
  }

  // ── change detection ──────────────────────────────────────────────────

  /**
   * The app calls this on EVERY change to the editor's document. "Has the
   * open file changed?" is answered by CONTENT, not by counting changes:
   * the old rule (swallow one change after an install) was fooled by the
   * editor's own first measurement, which marked every freshly opened file
   * unsaved and rewrote it (C1).
   */
  contentChanged(): void {
    if (this.installing) return;
    const controller = this.saveController;
    if (!controller || !controller.isActiveWritable) return;
    this.scheduleJournal();
    const active = controller.activeFileId;
    if (active !== null && controller.isDirty(active)) {
      controller.markChanged(); // already unsaved: just re-arm
      this.promoteActive();
      return;
    }
    this.armSettle();
  }

  private compareNow(): void {
    const controller = this.saveController;
    if (!controller || !controller.isActiveWritable || !this.adapter.serialize) return;
    const signature = this.signatureOf(this.adapter.serialize());
    if (this.baseline === null) {
      // First settle after an open or create: this IS the file's content.
      this.baseline = signature;
      return;
    }
    if (signature !== this.baseline) {
      controller.markChanged();
      this.promoteActive();
    }
  }

  /**
   * W1: an edit still inside the settle window is NOT yet "unsaved", so a
   * switch made within it would leave the file without saving the edit.
   * Every flow that leaves the open file runs the pending comparison first,
   * while the editor still shows that file.
   */
  private flushPendingChange(): void {
    if (this.settleTimer === undefined) return;
    this.clearSettle();
    this.compareNow();
  }

  private clearSettle(): void {
    if (this.settleTimer === undefined) return;
    this.timers.clear(this.settleTimer);
    this.settleTimer = undefined;
  }

  /** An edit makes a preview tab permanent (VS Code). */
  private promoteActive(): void {
    const active = this.current;
    if (active === null) return;
    const id = this.fileTabId(active);
    if (this.tabsState.preview === id) this.dispatchTabs({ type: 'promote', id });
  }

  // ── saving ────────────────────────────────────────────────────────────

  private async writeFile(
    fileId: string,
    text: string,
    writeOptions?: { force?: boolean },
  ): Promise<void> {
    const original = this.originals.get(fileId);
    if (original !== undefined) {
      const node = this.library.tree.nodes[fileId];
      if (node && this.adapter.onFirstSaveOfWarnedFile) {
        // Throws → the save fails and the edit stays unsaved; the backup is
        // never silently dropped (B10).
        await this.adapter.onFirstSaveOfWarnedFile(original, { id: fileId, node, library: this.library });
      }
      this.originals.delete(fileId);
    }
    try {
      await this.library.write(fileId, text, writeOptions);
    } catch (error) {
      // A linked file changed on disk: pause saving and let the user choose,
      // instead of a confirm popping up from a timer (D2).
      if (error instanceof ConflictError) {
        this.conflictState = {
          fileId,
          name: this.library.tree.nodes[fileId]?.name ?? error.fileName,
        };
        if (this.saveController?.activeFileId === fileId) this.saveController.setWritable(false);
        this.emit();
      }
      throw error;
    }
    const signature = this.signatureOf(text);
    this.fileSignatures.set(fileId, signature);
    if (fileId === this.saveController?.activeFileId) this.baseline = signature;
  }

  /** Save the open file now (Ctrl+S, "Save now"). */
  async saveNow(): Promise<void> {
    this.flushPendingChange();
    await this.saveController?.save().catch(() => {});
  }

  async setAutoSave(next: Partial<SaveSettings>): Promise<void> {
    const controller = this.saveController;
    if (!controller) return;
    await controller.setSettings({ ...controller.getSettings(), ...next });
  }

  /** Unsaved edits of `fileId` (the open file's, or a buffered one's). */
  isFileDirty(fileId: string): boolean {
    return this.saveController?.isDirty(fileId) ?? false;
  }

  /** For the strip: only file tabs are ever dirty. */
  isDirty(id: TabId): boolean {
    const fileId = this.fileIdOf(id);
    return fileId !== null && this.isFileDirty(fileId);
  }

  /** What a closing browser tab would actually LOSE: buffered files (the
   *  open file's pending edit is carried by the journal). For
   *  `beforeunload`. */
  hasUnsavedBuffers(): boolean {
    return this.saveController?.hasBufferedFiles() ?? false;
  }

  /** Overwrite the file that changed on disk with this session's version. */
  async overwriteConflict(): Promise<void> {
    const conflict = this.conflictState;
    const controller = this.saveController;
    if (!conflict || !controller || !this.adapter.serialize) return;
    const isOpen = controller.activeFileId === conflict.fileId;
    // W2: the conflicted file may not be the open one (a buffered file saved
    // on close). Its version is its BUFFER, never the editor's content.
    const text = isOpen ? this.adapter.serialize() : controller.takeBuffer(conflict.fileId);
    if (text === undefined) {
      this.conflictState = null;
      this.emit();
      return;
    }
    try {
      await this.library.write(conflict.fileId, text, { force: true });
    } catch {
      if (!isOpen) controller.restoreBuffer(conflict.fileId, text);
      return;
    }
    this.conflictState = null;
    const signature = this.signatureOf(text);
    this.fileSignatures.set(conflict.fileId, signature);
    if (isOpen) {
      controller.setWritable(this.writable());
      await controller.save().catch(() => {}); // clears the dirty flag
      this.baseline = signature;
    }
    this.emit();
  }

  /** Drop this session's version and load the file from disk. */
  async reloadConflict(): Promise<void> {
    const conflict = this.conflictState;
    if (!conflict) return;
    this.conflictState = null;
    this.forget([conflict.fileId]);
    this.snapshots.delete(conflict.fileId);
    this.emit();
    await this.load(conflict.fileId, true);
  }

  // ── the journal ───────────────────────────────────────────────────────

  private scheduleJournal(): void {
    if (!this.options.journal) return;
    if (this.journalTimer !== undefined) this.timers.clear(this.journalTimer);
    this.journalTimer = this.timers.set(() => {
      this.journalTimer = undefined;
      this.flushJournal();
    }, JOURNAL_DELAY_MS);
  }

  /**
   * Write the journal NOW (call it on `pagehide`: the one write a closing
   * tab can still complete). Written only while a WRITABLE library file is
   * open, so a detached or frozen editor never reaches a file (B2/B3).
   */
  flushJournal(): void {
    if (this.journalTimer !== undefined) {
      this.timers.clear(this.journalTimer);
      this.journalTimer = undefined;
    }
    const journal = this.options.journal;
    const controller = this.saveController;
    if (!journal || !controller || !this.adapter.serialize || this.sessionReadOnly) return;
    const active = controller.activeFileId;
    if (active === null || !controller.isActiveWritable || !this.library.tree.nodes[active]) return;
    journal.save({ path: pathOf(this.library.tree, active), text: this.adapter.serialize() });
  }

  private clearJournal(): void {
    if (this.journalTimer !== undefined) {
      this.timers.clear(this.journalTimer);
      this.journalTimer = undefined;
    }
    this.options.journal?.clear();
  }

  private rememberOpen(fileId: string | null): void {
    if (this.sessionReadOnly) return;
    if (fileId === null) this.clearJournal();
    else this.scheduleJournal();
  }

  // ── the tab record ────────────────────────────────────────────────────

  /** The record follows the strip AND the tree (a rename or a move changes
   *  a stored path). Debounced; never in a read-only or frozen session,
   *  nor while the tree is not the real one (loading, reconnect). */
  private scheduleTabRecord(): void {
    if (this.options.persistTabs === false || this.sessionReadOnly) return;
    const mode = this.library.mode.kind;
    if (mode === 'loading' || mode === 'reconnect') return;
    if (this.recordTimer !== undefined) this.timers.clear(this.recordTimer);
    this.recordTimer = this.timers.set(() => {
      this.recordTimer = undefined;
      void this.flushTabRecord();
    }, TAB_RECORD_DELAY_MS);
  }

  /** Write the tab record now. */
  async flushTabRecord(): Promise<void> {
    if (this.recordTimer !== undefined) {
      this.timers.clear(this.recordTimer);
      this.recordTimer = undefined;
    }
    if (this.options.persistTabs === false || this.sessionReadOnly) return;
    const mode = this.library.mode.kind;
    if (mode === 'loading' || mode === 'reconnect') return;
    const tabs = this.tabsState;
    await this.records.remember({
      order: [...tabs.order],
      active: tabs.active,
      closed: [...tabs.closed],
      preview: tabs.preview,
      recent: this.recent.map((id) => this.fileTabId(id)),
    });
  }

  // ── library changes ───────────────────────────────────────────────────

  private onLibraryChange(): void {
    const snapshot = this.library.getSnapshot();
    const treeChanged = snapshot.tree !== this.lastTree;
    const modeChanged = snapshot.mode.kind !== this.lastModeKind;
    this.lastTree = snapshot.tree;
    this.lastModeKind = snapshot.mode.kind;
    if (treeChanged) {
      // Labels follow renames; a vanished file keeps its last name.
      for (const id of this.tabsState.order) {
        const fileId = this.fileIdOf(id);
        const node = fileId === null ? undefined : snapshot.tree.nodes[fileId];
        if (node) this.tabNames.set(id, node.name);
      }
      // The open file vanished from a linked folder (deleted or renamed
      // outside the app, seen by a re-scan): detach, so nothing keeps saving
      // to a file that is not there and the app can offer "Save to library"
      // (E6 / L11).
      const active = this.current;
      if (active !== null && snapshot.mode.kind === 'folder' && !snapshot.tree.nodes[active]) {
        this.forget([active]);
        this.baseline = null;
        this.clearJournal();
        if (this.shown === active) this.detachedState = true;
        this.shown = null;
      }
    }
    if (treeChanged || modeChanged) this.scheduleTabRecord();
    this.emit();
  }

  // ── opening ───────────────────────────────────────────────────────────

  /**
   * Keep the editor's document in memory before another tab replaces it.
   * Only when the editor really shows the open file: not while its open is
   * still in flight (W1b: a superseded open would otherwise file the NEXT
   * file's content under this id, and a later restore of that snapshot
   * saved it into the wrong file), and not under "Unsupported" (the editor
   * there shows the PREVIOUS file).
   */
  private captureActive(): void {
    const active = this.current;
    if (active === null || active !== this.shown || !this.adapter.capture) return;
    if (this.failure?.fileId === active) return;
    if (!this.tabsState.order.includes(this.fileTabId(active))) return; // nothing returns to it
    const entry: KeptSnapshot<Snapshot> = {
      snapshot: this.adapter.capture(),
      fileSignature: this.fileSignatures.get(active) ?? null,
    };
    this.snapshots.set(active, entry);
    this.lastCapture = { fileId: active, entry };
  }

  /**
   * Open a library file in a tab (or focus its tab) and show it. `preview`
   * opens it in the italic preview slot, replacing the previous preview.
   */
  async openFile(fileId: string, openOptions: { preview?: boolean } = {}): Promise<void> {
    const node = this.library.tree.nodes[fileId];
    if (!node || !isOpenableFile(node, this.library.policy)) return;
    this.bootJournalValid = false;
    // Before the strip changes: an edit still settling promotes its preview
    // tab, so the next preview open does not replace a just-edited tab.
    this.flushPendingChange();
    const id = this.fileTabId(fileId);
    this.tabNames.set(id, node.name);
    this.dispatchTabs({ type: 'open', id, preview: openOptions.preview });
    this.noteRecent(fileId);
    await this.load(fileId);
  }

  /** Open any tab: a file tab loads its file; other kinds are only shown
   *  in the strip (the app renders them) and the editor closes. */
  async openTab(id: TabId, openOptions: { preview?: boolean } = {}): Promise<void> {
    const fileId = this.fileIdOf(id);
    if (fileId !== null) return this.openFile(fileId, openOptions);
    if (!parseTabId(id)) return;
    this.flushPendingChange();
    this.dispatchTabs({ type: 'open', id, preview: openOptions.preview });
    await this.showTab(id);
  }

  /** Make a preview tab permanent (double-click). */
  promoteTab(id: TabId): void {
    this.dispatchTabs({ type: 'promote', id });
  }

  /**
   * Load a file into the editor. Steps, in order, each for a reason:
   *  1. a token: a later open supersedes this one at every await;
   *  2. capture the document being left, then settle it (saved or
   *     buffered) WHILE the editor still shows it;
   *  3. take this file's unsaved buffer, if any — a superseded open gives
   *     it back (C2);
   *  4. a refusal shows "Unsupported" and the file is never written (E6);
   *  5. the kept snapshot is reused only while the file still says what it
   *     said when the snapshot was taken.
   */
  private async load(fileId: string, force = false): Promise<void> {
    const node = this.library.tree.nodes[fileId];
    if (!node || !isOpenableFile(node, this.library.policy)) return;
    if (!force && fileId === this.current && !this.failure) return;
    const token = ++this.openToken;
    this.flushPendingChange();
    if (this.current !== fileId) this.captureActive();
    // Settle the file being left while its content is still in the editor.
    await this.switchTo(fileId, false);
    this.conflictState = null;
    const controller = this.saveController;
    const buffered = controller?.takeBuffer(fileId);
    let text = buffered;
    const file: DocumentFile = {
      id: fileId,
      node,
      buffered: buffered !== undefined,
      getFile: async () =>
        buffered !== undefined
          ? new File([buffered], node.name)
          : this.library.getFile(fileId),
      readText: async () => {
        text ??= await this.library.readText(fileId);
        return text;
      },
    };
    let result: LoadResult<Content>;
    try {
      result = await this.adapter.load(file);
    } catch (error) {
      if (token !== this.openToken) {
        if (buffered !== undefined) controller?.restoreBuffer(fileId, buffered);
        return;
      }
      this.showFailure(fileId, node.name, 'read', error instanceof Error ? error.message : 'It could not be read.', buffered);
      return;
    }
    if (token !== this.openToken) {
      // Another click won: give back the buffer we took (C2).
      if (buffered !== undefined) controller?.restoreBuffer(fileId, buffered);
      return;
    }
    if (!result.ok) {
      this.library.markUnsupported(fileId, true);
      this.showFailure(fileId, node.name, 'unsupported', result.detail, buffered);
      return;
    }
    this.library.markUnsupported(fileId, false);
    this.failure = null;
    this.detachedState = false;
    // Switching back to a tab: its in-memory copy is used when it still says
    // what the file says — always for unsaved edits (the buffer IS that
    // copy), and for a clean file only when the file was not changed
    // outside the app meanwhile.
    const kept = this.snapshots.get(fileId);
    const fileSignature =
      buffered !== undefined
        ? undefined
        : result.signature !== undefined
          ? result.signature
          : text !== undefined
            ? this.signatureOf(text)
            : null;
    if (fileSignature !== undefined) this.fileSignatures.set(fileId, fileSignature);
    const restore = this.adapter.restore?.bind(this.adapter);
    const keptMatches =
      kept !== undefined &&
      restore !== undefined &&
      (buffered !== undefined ||
        (kept.fileSignature !== null && kept.fileSignature === fileSignature));
    if (kept && restore && keptMatches) {
      this.installContent(() => restore(kept.snapshot));
    } else {
      this.snapshots.delete(fileId);
      const content = result.content;
      this.installContent(() => this.adapter.install(content));
    }
    this.shown = fileId;
    if (result.warnings && result.warnings.length > 0 && buffered === undefined && text !== undefined) {
      this.originals.set(fileId, text);
    }
    controller?.setWritable(this.writable());
    // The buffer is newer than the file: unsaved from the start.
    if (buffered !== undefined) controller?.markChanged();
    this.rememberOpen(fileId);
    this.emit();
  }

  private showFailure(
    fileId: string,
    name: string,
    reason: OpenFailure['reason'],
    detail: string,
    buffered: string | undefined,
  ): void {
    this.adapter.silence?.();
    this.failure = { fileId, name, detail, reason };
    // W3: never lose a buffer to a failed open; it returns when the editor
    // leaves this file.
    if (buffered !== undefined) this.heldBuffer = { fileId, text: buffered };
    this.emit();
  }

  /**
   * Show `id` in the editor (its tab must exist). A non-file tab (or
   * `null`) closes the editor. Also ends a `detach()`: `showTab(active)`
   * brings the open tab back exactly as it was settled.
   */
  async showTab(id: TabId | null): Promise<void> {
    const fileId = id === null ? null : this.fileIdOf(id);
    if (fileId === null) {
      this.flushPendingChange();
      this.captureActive();
      await this.closeEditor();
      return;
    }
    if (!this.library.tree.nodes[fileId]) {
      await this.showMissing(fileId);
      return;
    }
    await this.load(fileId, this.current !== fileId);
  }

  /** End a `detach()`: the active tab comes back. */
  reattach(): Promise<void> {
    return this.showTab(this.tabsState.active);
  }

  /** A file tab whose file is gone: show its last in-memory copy,
   *  detached (never saved), or nothing. */
  private async showMissing(fileId: string): Promise<void> {
    const kept = this.snapshots.get(fileId);
    this.openToken += 1;
    this.flushPendingChange();
    this.captureActive();
    await this.detachEditor();
    this.failure = null;
    const restore = this.adapter.restore?.bind(this.adapter);
    if (kept && restore) {
      this.installContent(() => restore(kept.snapshot));
      this.detachedState = true;
    } else {
      this.installContent(() => this.adapter.closeEditor());
      this.detachedState = false;
    }
    this.emit();
  }

  /** Nothing is open: the editor closes. */
  private async closeEditor(): Promise<void> {
    this.openToken += 1;
    await this.switchTo(null, false);
    this.baseline = null;
    this.conflictState = null;
    this.failure = null;
    this.detachedState = false;
    this.shown = null;
    this.clearJournal();
    this.installContent(() => this.adapter.closeEditor());
    this.emit();
  }

  /** Detach the editor from its file (it keeps showing what it shows). */
  private async detachEditor(): Promise<void> {
    await this.switchTo(null, false);
    this.baseline = null;
    this.shown = null;
    this.conflictState = null;
    this.clearJournal();
  }

  /**
   * Hand the editor to something that is NOT a library document (Nodestra's
   * landing piano, a probe): the open file is captured and settled — saved,
   * or buffered with auto-save off — and detached, so nothing shown next is
   * ever written. `showTab(active)` / `reattach()` brings it back. An open
   * already in flight is cancelled (it must not land on the loan).
   */
  async detach(): Promise<void> {
    this.bootJournalValid = false;
    this.openToken += 1;
    this.flushPendingChange();
    this.captureActive();
    await this.detachEditor();
    this.failure = null;
    this.detachedState = true;
    this.emit();
  }

  /** Nothing is written for the rest of this session (Nodestra's
   *  `__probe`): read-only, no journal, no tab record; then `detach()`. */
  freeze(): Promise<void> {
    this.frozenState = true;
    this.bootJournalValid = false;
    if (this.recordTimer !== undefined) {
      this.timers.clear(this.recordTimer);
      this.recordTimer = undefined;
    }
    // The open file is still settled by `detach()` (the user's own pending
    // edit is saved or buffered); only what the editor shows NEXT is never
    // written.
    return this.detach();
  }

  /**
   * Create a library file and make it the open one. With `content`, it is
   * installed in the editor; without, the editor already shows it ("Save to
   * library", first-run migration) and is not reinstalled (L16). If the
   * library cannot take the file, `content` STILL loads — detached —
   * because the user's click must always do what it asked (L6 / F1).
   * Resolves to the new id, or `null` when it loaded detached.
   */
  async createAndOpen(
    parentId: string,
    name: string,
    data: WriteData,
    createOptions: { content?: Content } = {},
  ): Promise<string | null> {
    const installs = 'content' in createOptions;
    if (installs) this.bootJournalValid = false;
    const loadDetached = async (): Promise<null> => {
      this.openToken += 1;
      this.flushPendingChange();
      this.captureActive();
      await this.detachEditor();
      this.failure = null;
      if (installs) {
        const content = createOptions.content as Content;
        this.installContent(() => this.adapter.install(content));
        this.detachedState = true;
      }
      this.emit();
      return null;
    };
    if (!this.writable()) return loadDetached();
    let id: string;
    try {
      id = await this.library.createFile(parentId, name, data);
    } catch {
      return loadDetached(); // the library's error says why
    }
    this.openToken += 1;
    this.flushPendingChange();
    this.captureActive();
    const signature = typeof data === 'string' ? this.signatureOf(data) : null;
    this.fileSignatures.set(id, signature);
    await this.switchTo(id, this.writable());
    this.failure = null;
    this.conflictState = null;
    this.detachedState = false;
    const tab = this.fileTabId(id);
    this.tabNames.set(tab, this.library.tree.nodes[id]?.name ?? name);
    this.dispatchTabs({ type: 'open', id: tab });
    this.noteRecent(id);
    if (installs) {
      const content = createOptions.content as Content;
      this.installContent(() => this.adapter.install(content));
    } else {
      this.baseline = signature;
    }
    this.shown = id;
    this.rememberOpen(id);
    this.emit();
    return id;
  }

  // ── tab operations ────────────────────────────────────────────────────

  async activateTab(id: TabId): Promise<void> {
    const tabs = this.tabsState;
    if (!tabs.order.includes(id) || tabs.active === id) return;
    this.bootJournalValid = false;
    this.flushPendingChange();
    this.dispatchTabs({ type: 'activate', id });
    await this.showTab(id);
  }

  /**
   * Close tabs. Unsaved files ask first (Save / Don't save / Cancel). The
   * closing files are forgotten BEFORE the editor switches, so "Don't save"
   * is never undone by the switch's own save of the file being left.
   */
  async closeTabs(ids: readonly TabId[]): Promise<void> {
    const requested = ids.filter((id) => this.tabsState.order.includes(id));
    if (requested.length === 0) return;
    // An edit still settling counts as unsaved (W1).
    this.flushPendingChange();
    const others = requested.filter((id) => !this.isFileTab(id));
    if (others.length > 0 && this.options.beforeCloseTabs) {
      if (!(await this.options.beforeCloseTabs(others))) return;
    }
    const dirty = requested.filter((id) => this.isDirty(id));
    const controller = this.saveController;
    if (dirty.length > 0 && controller) {
      const choice = this.options.confirmUnsaved
        ? await this.options.confirmUnsaved(dirty.map((id) => this.label(id)))
        : 'save';
      if (choice === 'cancel') return;
      if (choice === 'save') {
        try {
          for (const fileId of this.fileIdsOf(dirty)) {
            if (fileId === controller.activeFileId) await controller.save();
            else await controller.saveBuffered(fileId);
          }
        } catch {
          return; // still unsaved: the tabs stay open
        }
        // A save that could not happen (paused by a conflict, read-only)
        // keeps the tab rather than dropping the edit.
        if (dirty.some((id) => this.isDirty(id))) return;
      }
    }
    // The prompt was async: act on the strip as it is NOW.
    const current = this.tabsState;
    const closing = requested.filter((id) => current.order.includes(id));
    if (closing.length === 0) return;
    const activeClosing = current.active !== null && closing.includes(current.active);
    const next = activeAfterClose(current, closing);
    const closingFiles = this.fileIdsOf(closing);
    this.forget(closingFiles);
    for (const fileId of closingFiles) this.snapshots.delete(fileId);
    this.dispatchTabs({ type: 'close', ids: closing });
    if (activeClosing) await this.showTab(next);
  }

  closeOtherTabs(id: TabId): Promise<void> {
    return this.closeTabs(othersOf(this.tabsState, id));
  }

  closeTabsToTheRight(id: TabId): Promise<void> {
    return this.closeTabs(rightOf(this.tabsState, id));
  }

  /** Every tab without unsaved edits (non-file tabs included). */
  closeSavedTabs(): Promise<void> {
    this.flushPendingChange();
    return this.closeTabs(this.tabsState.order.filter((id) => !this.isDirty(id)));
  }

  closeAllTabs(): Promise<void> {
    return this.closeTabs(this.tabsState.order);
  }

  reorderTab(id: TabId, toIndex: number): void {
    this.dispatchTabs({ type: 'reorder', id, toIndex });
  }

  /** Reopen the most recently closed tab that can still open. */
  async reopenClosedTab(): Promise<void> {
    const before = this.tabsState;
    const tree = this.library.tree;
    this.dispatchTabs({
      type: 'reopen',
      canReopen: (id) => {
        const fileId = this.fileIdOf(id);
        if (fileId === null) return this.options.canReopen?.(id) ?? true;
        const node = tree.nodes[fileId];
        return node !== undefined && isOpenableFile(node, this.library.policy);
      },
    });
    const after = this.tabsState;
    if (after === before || after.active === null) return;
    this.bootJournalValid = false;
    const fileId = this.fileIdOf(after.active);
    if (fileId !== null) {
      const node = tree.nodes[fileId];
      if (node) this.tabNames.set(after.active, node.name);
      this.noteRecent(fileId);
    }
    await this.showTab(after.active);
  }

  /** Files gone for good (deleted in the app): their tabs close without
   *  asking — the deletion was confirmed. */
  private async dropTabs(ids: readonly TabId[]): Promise<void> {
    const current = this.tabsState;
    const gone = ids.filter((id) => current.order.includes(id));
    if (gone.length === 0) return;
    const activeGone = current.active !== null && gone.includes(current.active);
    const next = activeAfterClose(current, gone);
    for (const fileId of this.fileIdsOf(gone)) this.snapshots.delete(fileId);
    this.dispatchTabs({ type: 'close', ids: gone });
    if (activeGone) await this.showTab(next);
  }

  /** The strip's label: a file tab shows its file's CURRENT name (renames
   *  follow), or its last known name once the file is gone. */
  label(id: TabId): string {
    const parsed = parseTabId(id);
    if (!parsed) return id;
    if (parsed.kind === this.fileKind) {
      return this.library.tree.nodes[parsed.key]?.name ?? this.tabNames.get(id) ?? 'Missing file';
    }
    return (
      this.options.label?.({ id, kind: parsed.kind, key: parsed.key }) ??
      parsed.kind.charAt(0).toUpperCase() + parsed.kind.slice(1)
    );
  }

  /** A file tab whose file no longer exists (deleted outside the app). */
  isTabMissing(id: TabId): boolean {
    const fileId = this.fileIdOf(id);
    return fileId !== null && !this.library.tree.nodes[fileId];
  }

  // ── tree operations ───────────────────────────────────────────────────

  /** Rename; the tab keeps its id and its label follows. */
  async rename(id: string, name: string): Promise<boolean> {
    try {
      await this.library.rename(id, name);
    } catch {
      return false; // the library's error says why
    }
    const active = this.current;
    if (active !== null && subtreeIds(this.library.tree, id).includes(active)) this.rememberOpen(active);
    return true;
  }

  async move(ids: readonly string[], targetFolderId: string): Promise<boolean> {
    try {
      await this.library.move(ids, targetFolderId);
    } catch {
      return false;
    }
    const active = this.current;
    if (active !== null) this.rememberOpen(active);
    return true;
  }

  /** Delete after `confirm` (with what goes, and whether it is on disk).
   *  The deleted files' tabs close without asking. */
  async remove(ids: readonly string[]): Promise<boolean> {
    const tree = this.library.tree;
    const present = ids.filter((id) => tree.nodes[id]);
    if (present.length === 0) return false;
    const policy = this.library.policy;
    const affected = present.flatMap((id) => subtreeIds(tree, id));
    const files = affected.map((id) => tree.nodes[id]).filter((node) => node.kind === 'file');
    const openable = files.filter((node) => isOpenableFile(node, policy)).length;
    const onDisk = this.library.mode.kind === 'folder';
    const hidden = onDisk ? await this.library.hiddenEntriesIn(present).catch(() => 0) : 0;
    const label = present.length === 1 ? `"${tree.nodes[present[0]].name}"` : `${present.length} items`;
    const confirmed = await this.ask({
      kind: 'delete',
      label,
      onDisk,
      openable,
      otherFiles: files.length - openable,
      hidden,
      permanent: files.filter((node) => !policy.keepForUndo(node)).length,
    });
    if (!confirmed) return false;
    const activeGone = this.current !== null && affected.includes(this.current);
    try {
      await this.library.remove(present);
    } catch {
      return false;
    }
    this.forget(affected);
    if (activeGone) {
      this.baseline = null;
      this.shown = null;
      this.clearJournal();
    }
    if (this.failure && affected.includes(this.failure.fileId)) this.failure = null;
    await this.dropTabs(affected.map((id) => this.fileTabId(id)));
    this.emit();
    return true;
  }

  async undoDelete(): Promise<string[]> {
    return this.library.undoDelete().catch(() => []);
  }

  // ── link / unlink / reconnect ─────────────────────────────────────────

  private ask(request: ConfirmRequest): Promise<boolean> {
    return this.options.confirm ? this.options.confirm(request) : Promise.resolve(true);
  }

  /**
   * LINK a folder the app has ALREADY picked. Contract (E1): call
   * `pickFolder()` directly in the click handler, before any await or
   * confirm — a confirm first spent the click's user activation and the
   * picker then failed silently. This method asks `confirm` only after.
   *
   * The in-browser library is discarded: every file tab closes and the
   * discarded files' unsaved buffers go too — they would otherwise haunt
   * every reload with "Leave site?" (E3).
   *
   * `access` is what the user chose for this folder (ask before the picker,
   * and pick with the same mode: `pickFolder({ access })`). Default: the
   * library's `access` option.
   */
  async link(
    handle: FileSystemDirectoryHandle,
    linkOptions: { access?: FolderAccess } = {},
  ): Promise<boolean> {
    if (this.sessionReadOnly) return false;
    const { openable, folders } = this.library.unlinkSummary();
    if (
      this.library.mode.kind === 'memory' &&
      openable + folders > 0 &&
      !(await this.ask({ kind: 'link', folderName: handle.name, openable, folders }))
    ) {
      return false;
    }
    this.flushPendingChange();
    await this.saveController?.flush().catch(() => {});
    const discarded = Object.keys(this.library.tree.nodes);
    try {
      await this.library.link(handle, linkOptions);
    } catch {
      return false; // the library's error says why
    }
    this.forget(discarded);
    this.snapshots.clear();
    this.fileSignatures.clear();
    this.recent = [];
    this.dispatchTabs({ type: 'retain', keep: (id) => !this.isFileTab(id) });
    await this.closeEditor();
    return true;
  }

  /**
   * UNLINK: measure (`library.planUnlink()`), ask `chooseUnlink` — KEEP a
   * copy in the browser, REMOVE, or cancel — then do it. A KEEP copy reports
   * progress (`onProgress`, and `snapshot.library.unlinkProgress`) and can
   * be cancelled (`signal`, or `cancelUnlink()`); a failed or cancelled copy
   * leaves the folder linked and unchanged, and resolves `false`.
   *
   * KEEP keeps ids, so the open file stays open (now in the browser) —
   * unless it is showing "Unsupported", which must stay unwritable (E6).
   * Tabs of files that are no longer in the library (REMOVE, or files the
   * policy leaves on disk) close.
   */
  async unlink(
    unlinkOptions: { signal?: AbortSignal; onProgress?(progress: UnlinkProgress): void } = {},
  ): Promise<boolean> {
    if (this.sessionReadOnly) return false;
    let plan: UnlinkPlan;
    try {
      plan = await this.library.planUnlink();
    } catch {
      return false; // the library's error says why
    }
    const choice: UnlinkChoice = this.options.chooseUnlink
      ? await this.options.chooseUnlink(plan)
      : plan.mode === 'folder'
        ? 'keep'
        : 'remove';
    if (choice === 'cancel') return false;
    const keep = choice === 'keep' && plan.mode === 'folder';
    this.flushPendingChange();
    await this.saveController?.flush().catch(() => {});
    try {
      await this.library.unlink({ keep, signal: unlinkOptions.signal, onProgress: unlinkOptions.onProgress });
    } catch {
      return false; // still linked; the library's error (or notice) says why
    }
    const tree = this.library.tree;
    const active = this.current;
    if (keep && active !== null && tree.nodes[active] && this.failure?.fileId !== active) {
      this.saveController?.setWritable(this.writable());
      this.rememberOpen(active);
    } else {
      const shownGone = this.shown !== null && this.shown === active;
      await this.detachEditor();
      if (shownGone) this.detachedState = true;
    }
    // Files no longer in the library: their tabs go, without asking (the
    // user chose this), and with them their buffers and snapshots.
    const gone = this.tabsState.order
      .map((id) => this.fileIdOf(id))
      .filter((fileId): fileId is string => fileId !== null && !tree.nodes[fileId]);
    if (gone.length > 0) {
      this.forget(gone);
      if (this.failure && gone.includes(this.failure.fileId)) this.failure = null;
      await this.dropTabs(gone.map((fileId) => this.fileTabId(fileId)));
    }
    this.emit();
    return true;
  }

  /** Cancel a KEEP copy in progress; the folder stays linked. */
  cancelUnlink(): void {
    this.library.cancelUnlink();
  }

  /**
   * Switch the linked folder between read-only and read & write (persisted
   * for this folder). An UPGRADE asks the browser — call it straight from
   * the click; the request is the first thing that happens. A refusal keeps
   * it read-only (the library's `notice` says so). A DOWNGRADE first saves
   * the open file's pending edit, then waits for queued writes. Resolves
   * whether the folder now has `access`.
   */
  async setFolderAccess(access: FolderAccess): Promise<boolean> {
    if (this.sessionReadOnly) return false;
    if (access === 'read') {
      this.flushPendingChange();
      await this.saveController?.flush().catch(() => {});
    }
    const done = await this.library.setAccess(access); // upgrade: NO await before this (FB-28)
    const active = this.current;
    if (active !== null && !this.failure && !this.conflictState) {
      this.saveController?.setWritable(this.writable());
    }
    this.emit();
    return done;
  }

  /**
   * Re-grant access to the linked folder. Call it straight from the click:
   * the permission request is the FIRST thing that happens, with no await
   * before it, or the click's user activation is spent (FB-28). Then the
   * remembered tabs come back (and an adoptable journal).
   *
   * `access: 'read'` continues read-only a folder linked read & write whose
   * write permission the browser no longer holds (remembered as its mode).
   */
  async reconnect(reconnectOptions: { access?: FolderAccess } = {}): Promise<boolean> {
    if (this.sessionReadOnly) return false;
    try {
      await this.library.reconnect(reconnectOptions); // NO await before this line (FB-28)
    } catch {
      return false;
    }
    if (this.current === null) {
      const adopted = this.bootJournalValid && (await this.adoptJournal());
      await this.restoreTabs(adopted ? this.current : null);
    } else if (!this.failure) {
      this.saveController?.setWritable(this.writable());
    }
    this.emit();
    return true;
  }

  // ── boot ──────────────────────────────────────────────────────────────

  /**
   * Initialise the library and bring the session back: an adoptable
   * journal, the remembered tabs, or — on a first visit — migration and
   * the Welcome tab. Idempotent: StrictMode's double effects and a
   * hot-swapped caller must not boot twice (E4).
   */
  boot(): Promise<void> {
    this.bootPromise ??= this.doBoot();
    return this.bootPromise;
  }

  private async doBoot(): Promise<void> {
    await this.library.init();
    if (this.sessionReadOnly) return;
    if (this.library.mode.kind === 'reconnect') return; // waits for a click
    const startup = this.options.startup ?? {};
    const welcome = this.options.welcomeTab;
    if (!(await this.library.isInitialized())) {
      await this.library.markInitialized();
      // First visit: NOTHING opens, except older work brought in by the app
      // so it is never lost (Nodestra's old single autosave, Q7-F2).
      if (startup.migrateFirstVisit && this.current === null && this.bootJournalValid) {
        if (await startup.migrateFirstVisit()) {
          startup.onStartupOpened?.(1);
          return;
        }
      }
      if (welcome !== undefined && this.tabsState.order.length === 0) {
        this.dispatchTabs({ type: 'open', id: welcome });
      }
      startup.onFirstVisit?.();
      return;
    }
    // The user already opened something while the library loaded: keep it.
    if (this.current !== null || !this.bootJournalValid) return;
    // Later visits: the tabs come back (and this browser tab's crash
    // journal, if it restored, is the active one).
    const adopted = await this.adoptJournal();
    const count = await this.restoreTabs(adopted ? this.current : null);
    if (count > 0) startup.onStartupOpened?.(count);
    else if (
      welcome !== undefined &&
      this.tabsState.order.length === 0 &&
      (startup.showWelcomeOnStartup?.() ?? true)
    ) {
      this.dispatchTabs({ type: 'open', id: welcome });
    }
  }

  /**
   * Adopt the file the boot journal belongs to. The editor already shows
   * the journal (the newest copy of that file); this decides whether it is
   * unsaved relative to the file — by CONTENT signature, since raw text
   * may never match (B4). Only a journal the app restored at boot can be
   * adopted: never content loaded while a folder awaited reconnection (B2),
   * never a journal that failed to restore (B3).
   */
  private async adoptJournal(): Promise<boolean> {
    const journal = this.options.journal;
    const controller = this.saveController;
    if (!journal || !controller) return false;
    const path = journal.bootPath();
    const node = path ? findByPath(this.library.tree, path) : undefined;
    if (!node || !isOpenableFile(node, this.library.policy)) return false;
    const stored = await this.library.readText(node.id).catch(() => undefined);
    if (stored === undefined) return false;
    const entry = journal.load();
    const id = this.fileTabId(node.id);
    this.tabNames.set(id, node.name);
    const signature = this.signatureOf(stored);
    this.fileSignatures.set(node.id, signature);
    this.dispatchTabs({ type: 'open', id });
    this.noteRecent(node.id);
    await this.switchTo(node.id, this.writable());
    this.baseline = signature;
    this.shown = node.id;
    if (entry && this.signatureOf(entry.text) !== signature) controller.markChanged();
    this.rememberOpen(node.id);
    this.emit();
    return true;
  }

  /**
   * Put the remembered tabs back (boot, reconnect). `alreadyOpen` is a file
   * the journal just adopted — it stays active. Only the active tab loads;
   * the others load when clicked. Resolves to the number of FILE tabs.
   */
  private async restoreTabs(alreadyOpen: string | null): Promise<number> {
    const record = this.options.persistTabs === false ? null : await this.records.recall();
    if (record) {
      const recalled = this.fileIdsOf(record.recent);
      this.recent = [...new Set([...this.recent, ...recalled])].slice(0, this.maxRecent);
    }
    const order = record ? [...record.order] : [];
    const adopted = alreadyOpen === null ? null : this.fileTabId(alreadyOpen);
    if (adopted !== null && !order.includes(adopted)) order.push(adopted);
    if (order.length === 0) return 0;
    for (const id of order) {
      const fileId = this.fileIdOf(id);
      const node = fileId === null ? undefined : this.library.tree.nodes[fileId];
      if (node) this.tabNames.set(id, node.name);
    }
    const active = adopted ?? record?.active ?? order[0];
    this.dispatchTabs({
      type: 'restore',
      state: {
        order,
        active,
        mru: [active, ...order.filter((id) => id !== active)],
        closed: record?.closed ?? [],
        preview: record?.preview ?? null,
      },
    });
    const activeFile = this.fileIdOf(active);
    if (adopted === null && activeFile !== null) await this.load(activeFile);
    return order.filter((id) => this.isFileTab(id)).length;
  }
}

export { CHANGE_SETTLE_MS, Workspace };
export type {
  ConfirmRequest,
  DocumentAdapter,
  DocumentFile,
  Journal,
  JournalEntry,
  LoadResult,
  OpenFailure,
  SaveConflict,
  SaveStatus,
  UnlinkChoice,
  UnsavedChoice,
  WorkspaceOptions,
  WorkspaceSnapshot,
};
