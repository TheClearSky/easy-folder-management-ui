/**
 * The file library: one tree, one storage backend at a time, one queue.
 *
 * Framework-free (subscribe / getSnapshot for `useSyncExternalStore`) so the
 * behaviour can be tested without a DOM. Prompts are NOT made here — the UI
 * asks the user, then calls in.
 *
 * THE QUEUE. Every operation that touches storage runs one at a time, in
 * call order, and the tree only changes after its storage operation
 * succeeded — so a refused disk operation leaves nothing to roll back.
 *
 * THE MUTATION GUARD runs BEFORE an operation enters the queue, never inside
 * it. Before a rename, move or delete, `beforeMutate(affectedIds)` lets the
 * app save the open file; that save is itself a queued write. Awaiting it
 * from INSIDE a queued operation deadlocked the whole library — the save
 * waited behind the operation that waited for the save — and every later
 * open, save and demo hung until reload (review/2026-09-26-library, A1).
 */

import {
  canLinkFolders,
  ConflictError,
  FolderBackend,
  folderPermission,
  MemoryBackend,
  scanFolder,
} from './backends';
import type { FolderAccess, LibraryBackend, WriteData, WriteOptions } from './backends';
import {
  canUseOpfs,
  createOpfsBlobStore,
  estimateStorage,
  requestPersistentStorage,
  withBlobLock,
} from './blobStore';
import type { BlobStore, StorageInfo } from './blobStore';
import { formatBytes } from './format';
import { createMemoryStore } from './keyValueStore';
import type { KeyValueStore } from './keyValueStore';
import {
  addNode,
  childNamed,
  countContents,
  createEmptyTree,
  deserializeTree,
  findByPath,
  getNode,
  LibraryError,
  moveNode,
  pathOf,
  removeNode,
  renameNode,
  serializeTree,
  subtreeIds,
  topmostOnly,
} from './libraryTree';
import type { LibraryTree } from './libraryTree';
import { uniqueName } from './names';
import type { FilePolicy } from './policy';

type LibraryMode =
  | { kind: 'loading' }
  | { kind: 'memory' }
  | { kind: 'folder'; folderName: string }
  /** A folder is linked but the browser needs a click to re-grant access. */
  | { kind: 'reconnect'; folderName: string };

type LibrarySnapshot = {
  mode: LibraryMode;
  tree: LibraryTree;
  /** Openable files the app could not open (shown as "unsupported"). */
  unsupported: ReadonlySet<string>;
  /** The last error worth showing, until dismissed. */
  error: string | null;
  /** Something the user should know that is not a failure. */
  notice: string | null;
  /** True while at least one WRITE is queued (reads do not count). */
  busy: boolean;
  /** A delete this session can still undo. */
  undoableDelete: string | null;
  /** The browser refused its storage; the library lives for this tab only. */
  storageUnavailable: boolean;
  /** What the linked folder may do — `'read'` (every change refused) or
   *  `'readwrite'`. In `reconnect` mode: the access Reconnect will ask for.
   *  `null` without a folder. Persisted next to the folder handle. */
  folderAccess: FolderAccess | null;
  /** An UNLINK that keeps a copy is copying; `null` otherwise. */
  unlinkProgress: UnlinkProgress | null;
};

/** What UNLINK would do, for the dialog that offers KEEP or REMOVE. */
type UnlinkPlan = {
  /** `'folder'`: a readable linked folder — KEEP can copy it. `'forget'`: a
   *  folder awaiting reconnection — nothing is readable, so the library just
   *  forgets it (REMOVE). */
  mode: 'folder' | 'forget';
  folderName: string;
  /** Everything in the tree, as listed. */
  folders: number;
  openable: number;
  otherFiles: number;
  /** What KEEP copies into the browser: every folder, the files the policy's
   *  `copyOnUnlink` allows, and their total size in bytes. */
  keep: {
    folders: number;
    files: number;
    bytes: number;
    /** Files the policy leaves on disk only. */
    leftOnDisk: number;
    /** Files whose size could not be read (they will be skipped). */
    unreadable: number;
  };
  /** This site's storage, when the browser says (`navigator.storage.estimate()`). */
  storage: StorageInfo | null;
  /** Does KEEP fit in the free space? `null` when the browser does not say. */
  fits: boolean | null;
};

type UnlinkProgress = {
  bytesCopied: number;
  bytesTotal: number;
  filesCopied: number;
  filesTotal: number;
  /** The file being copied, or `null` between files and while finishing. */
  currentFile: string | null;
};

type UnlinkOptions = {
  /** `true`: copy the folder into the browser (KEEP). `false`: the
   *  in-browser library ends up empty (REMOVE). Nothing on disk is touched
   *  either way. */
  keep: boolean;
  /** Cancels a KEEP copy; the folder stays linked and nothing is copied. */
  signal?: AbortSignal;
  /** Throttled (about ten times a second, plus the first and last). */
  onProgress?(progress: UnlinkProgress): void;
};

type UnlinkResult = {
  /** Files copied into the browser. */
  kept: number;
  /** Files that could not be read and were not copied. */
  skipped: number;
  /** Bytes copied. */
  bytes: number;
};

/** What a delete removed, enough to put it back (kept files and folders). */
type DeletedSubtree = {
  label: string;
  items: { path: string[]; kind: 'folder' | 'file'; data?: string | Blob }[];
};

const FOLDER_HANDLE_KEY = 'folderHandle';
const FOLDER_ACCESS_KEY = 'folderAccess';
const INITIALIZED_KEY = 'initialized';
/** Unlink progress reaches subscribers at most this often. */
const PROGRESS_INTERVAL_MS = 100;

/** Re-scans triggered by window focus are cheap only when rare. */
const MIN_RESCAN_INTERVAL_MS = 2000;

type FileLibraryOptions = {
  store: KeyValueStore;
  /** Which files the app opens and how their contents may be handled. */
  policy: FilePolicy;
  /** What a NEWLY linked folder may do, unless `link()` says otherwise.
   *  `'read'` asks the browser for read access only and refuses every change
   *  (create, rename, move, delete, write). Default `'readwrite'`. A linked
   *  folder's own access is persisted and wins after a reload. */
  access?: FolderAccess;
  /**
   * Where the in-browser library keeps BINARY contents (text is always a
   * string in `store`, the format Nodestra's libraries hold).
   *  - `'auto'` (default): a `'binary'` policy over a PERSISTENT store
   *    (`createIndexedDbStore(name)`) uses the Origin Private File System,
   *    directory `<name>.blobs`, when the browser has it — files are streamed
   *    there, never read into memory, and `getFile()` returns disk-backed
   *    Files. Otherwise (a text policy, `createMemoryStore`, no OPFS) binary
   *    contents are Blobs in `store`, as before.
   *  - a `BlobStore` (`createOpfsBlobStore(dir)`, `createMemoryBlobStore()`):
   *    use that one.
   *  - `null`: never a blob store.
   */
  blobStore?: BlobStore | 'auto' | null;
  /** Flush pending edits of any of these files before they move or vanish.
   *  Called OUTSIDE the queue. */
  beforeMutate?: (affectedIds: readonly string[]) => Promise<void>;
};

class FileLibrary {
  private snapshot: LibrarySnapshot = {
    mode: { kind: 'loading' },
    tree: createEmptyTree(),
    unsupported: new Set(),
    error: null,
    notice: null,
    busy: false,
    undoableDelete: null,
    storageUnavailable: false,
    folderAccess: null,
    unlinkProgress: null,
  };
  private readonly listeners = new Set<() => void>();
  private store: KeyValueStore;
  private memory: MemoryBackend;
  private backend: LibraryBackend;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingWrites = 0;
  private lastDelete: DeletedSubtree | null = null;
  private initPromise: Promise<void> | null = null;
  /** The linked folder's handle, kept so Reconnect can ask for permission
   *  synchronously inside the click (a queue hop or an IndexedDB read first
   *  would spend the click's user activation). */
  private storedHandle: FileSystemDirectoryHandle | null = null;
  private lastRescanAt = 0;
  private rescanning = false;
  private unlinkController: AbortController | null = null;
  private readonly explicitBlobStore: boolean;
  beforeMutate: (affectedIds: readonly string[]) => Promise<void>;
  readonly policy: FilePolicy;
  /** What the linked folder may do now (or, without one, what the next link
   *  gets by default). Change it with `setAccess()`. */
  get access(): FolderAccess {
    return this.accessState;
  }
  private accessState: FolderAccess;
  private readonly defaultAccess: FolderAccess;

  constructor(options: FileLibraryOptions) {
    this.store = options.store;
    this.policy = options.policy;
    this.defaultAccess = options.access ?? 'readwrite';
    this.accessState = this.defaultAccess;
    const option = options.blobStore === undefined ? 'auto' : options.blobStore;
    this.explicitBlobStore = option !== 'auto' && option !== null;
    const blobs =
      option === 'auto'
        ? this.policy.content === 'binary' && this.store.name && canUseOpfs()
          ? createOpfsBlobStore(`${this.store.name}.blobs`)
          : null
        : option;
    this.memory = new MemoryBackend(this.store, blobs);
    this.backend = this.memory;
    this.beforeMutate = options.beforeMutate ?? (async () => {});
  }

  /** The store binary contents of the in-browser library go to, if any. */
  get blobStore(): BlobStore | null {
    return this.memory.blobs;
  }

  // ── store plumbing ────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LibrarySnapshot => this.snapshot;

  private set(patch: Partial<LibrarySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  get tree(): LibraryTree {
    return this.snapshot.tree;
  }

  /** The key-value store the library persists into — the one it actually
   *  uses, which is an in-memory stand-in when the browser refused storage.
   *  Companions (the tab record) keep their own keys here. */
  get keyValueStore(): KeyValueStore {
    return this.store;
  }

  get mode(): LibraryMode {
    return this.snapshot.mode;
  }

  /** Can this tree be written right now? A read-only link never can. */
  get writable(): boolean {
    const { kind } = this.snapshot.mode;
    return kind === 'memory' || (kind === 'folder' && this.access === 'readwrite');
  }

  /**
   * Run `work` after everything queued before it. Errors are shown AND
   * rethrown. `write` operations drive the "Saving…" indicator.
   */
  private run<T>(work: () => Promise<T>, options: { write?: boolean } = {}): Promise<T> {
    const write = options.write ?? true;
    if (write) {
      this.pendingWrites += 1;
      if (!this.snapshot.busy) this.set({ busy: true });
    }
    const result = this.queue.then(work);
    this.queue = result
      .catch(() => {})
      .finally(() => {
        if (!write) return;
        this.pendingWrites -= 1;
        if (this.pendingWrites === 0) this.set({ busy: false });
      });
    return result.catch((error: unknown) => {
      // A conflict has its own UI; a cancel is the user's own choice.
      if (!(error instanceof ConflictError) && !isAbort(error)) {
        this.set({ error: describe(error) });
        this.noticeAccessLoss(error);
      }
      throw error;
    });
  }

  /** A folder whose permission was revoked, or which was moved or deleted,
   *  goes back to "Reconnect" — otherwise every later operation just fails
   *  with no way back short of a reload (FB-09). */
  private noticeAccessLoss(error: unknown): void {
    if (!(this.backend instanceof FolderBackend) || this.mode.kind !== 'folder') return;
    if (!(error instanceof DOMException)) return;
    if (error.name !== 'NotAllowedError' && error.name !== 'SecurityError') {
      if (error.name !== 'NotFoundError') return;
      // A missing FILE is normal; a missing ROOT is not. Probe the root.
      const root = this.backend.root;
      void (async () => {
        try {
          await root.keys().next();
        } catch {
          this.set({ mode: { kind: 'reconnect', folderName: root.name } });
        }
      })();
      return;
    }
    this.set({ mode: { kind: 'reconnect', folderName: this.backend.root.name } });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ── boot ──────────────────────────────────────────────────────────────

  /** Idempotent: React StrictMode runs effects twice, and two concurrent
   *  scans of one folder mint two different id sets (FB-15). */
  init(): Promise<void> {
    this.initPromise ??= this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    // Some browsers refuse IndexedDB only when it is first USED (private
    // modes); a probe decides up front whether the library can persist.
    try {
      await this.store.keys();
    } catch {
      this.store = createMemoryStore();
      this.memory = new MemoryBackend(this.store, this.explicitBlobStore ? this.memory.blobs : null);
      this.backend = this.memory;
      this.set({ storageUnavailable: true });
    }
    // The same probe for the automatic OPFS store (refused in some private
    // modes): without it, binary contents go into the key-value store.
    if (this.memory.blobs && !this.explicitBlobStore) {
      const usable = await this.memory.blobs.keys().then(
        () => true,
        () => false,
      );
      if (!usable) {
        this.memory = new MemoryBackend(this.store, null);
        this.backend = this.memory;
      }
    }
    const handle = await this.store
      .get<FileSystemDirectoryHandle>(FOLDER_HANDLE_KEY)
      .catch(() => undefined);
    if (handle && canLinkFolders()) {
      this.storedHandle = handle;
      // The access the user chose for THIS folder (0.0.4+); older stores
      // have none and get the `access` option.
      const stored = await this.store.get<unknown>(FOLDER_ACCESS_KEY).catch(() => undefined);
      const access: FolderAccess =
        stored === 'read' || stored === 'readwrite' ? stored : this.defaultAccess;
      this.accessState = access;
      // The in-browser store is empty while a folder is linked (LINK
      // discards it): anything in the blob store is left over.
      await this.memory.sweep(new Set()).catch(() => 0);
      const permission = await folderPermission(handle, false, access).catch(
        () => 'denied' as PermissionState,
      );
      if (permission === 'granted') {
        try {
          await this.attachFolder(handle, access);
          return;
        } catch {
          // Moved or deleted outside the app: fall through to "reconnect".
        }
      }
      // Not granted (Chrome forgets grants between visits unless the user
      // allowed "on every visit"): Reconnect asks for `access` again, or the
      // app offers `reconnect({ access: 'read' })` instead.
      this.backend = this.folderBackend(handle);
      this.set({ mode: { kind: 'reconnect', folderName: handle.name }, folderAccess: access });
      return;
    }
    const stored = await this.memory.loadStructure().catch(() => undefined);
    const parsed = stored ? deserializeTree(stored) : undefined;
    const tree = parsed || createEmptyTree();
    // Blob-store entries no file refers to (a copy cut short by a closed
    // tab). Never when a stored structure failed to parse: its files might
    // still be recoverable.
    if (stored === undefined || parsed) {
      const referenced = new Set(
        Object.values(tree.nodes)
          .filter((node) => node.kind === 'file')
          .map((node) => node.id),
      );
      await this.memory.sweep(referenced).catch(() => 0);
    }
    this.backend = this.memory;
    this.set({ mode: { kind: 'memory' }, tree });
  }

  /** Has this browser ever set up the library? Decides first-run migration
   *  — NOT an empty tree, which a user can legitimately reach (L15). */
  async isInitialized(): Promise<boolean> {
    return (await this.store.get<boolean>(INITIALIZED_KEY).catch(() => false)) === true;
  }

  async markInitialized(): Promise<void> {
    await this.store.set(INITIALIZED_KEY, true).catch(() => {});
  }

  private async attachFolder(handle: FileSystemDirectoryHandle, access: FolderAccess): Promise<void> {
    const { tree, unreadable } = await scanFolder(handle, undefined, this.scanOptions);
    this.backend = this.folderBackend(handle);
    this.storedHandle = handle;
    this.accessState = access;
    this.lastRescanAt = Date.now();
    this.set({
      mode: { kind: 'folder', folderName: handle.name },
      folderAccess: access,
      tree,
      unsupported: new Set(),
      notice:
        unreadable > 0
          ? `${unreadable} subfolder(s) could not be read and are not shown.`
          : null,
    });
  }

  /**
   * Re-grant access to the stored folder. MUST be called from a click, and
   * asks for permission FIRST — before any queue hop or storage read, which
   * would outlive the click's user activation.
   *
   * `access` defaults to the folder's own (persisted) access. Passing
   * `'read'` for a read-write folder whose write permission is gone after a
   * reload continues READ-ONLY instead (and remembers that choice).
   */
  reconnect(options: { access?: FolderAccess } = {}): Promise<void> {
    const handle = this.storedHandle;
    if (!handle) return Promise.reject(new LibraryError('No folder is linked.'));
    const access = options.access ?? this.accessState;
    const permission = folderPermission(handle, true, access); // FIRST (FB-28)
    return this.run(async () => {
      if ((await permission) !== 'granted') {
        throw new LibraryError(
          access === 'readwrite'
            ? 'The browser did not grant write access to the folder. You can continue read-only.'
            : 'The browser did not grant access to the folder.',
        );
      }
      if (access !== this.accessState || options.access !== undefined) {
        await this.store.set(FOLDER_ACCESS_KEY, access).catch(() => {});
      }
      await this.attachFolder(handle, access);
    }, { write: false });
  }

  /**
   * Switch the linked folder between read-only and read & write; the choice
   * is persisted next to the folder handle. Resolves `true` when the folder
   * now has `access`.
   *
   *  - UPGRADE (`'readwrite'`) needs the browser's permission: call it
   *    straight from a click — the request is the FIRST thing that happens.
   *    A refusal keeps the folder read-only and says so in `notice`.
   *  - DOWNGRADE (`'read'`) waits for every queued write (a save in flight)
   *    to finish, then refuses writes. The browser keeps its grant (there is
   *    no API to give it back); the library simply stops writing.
   *
   * The in-browser store is always writable: `'readwrite'` resolves `true`,
   * `'read'` resolves `false`. While a folder awaits reconnection, use
   * `reconnect({ access })` instead (this resolves `false`).
   */
  setAccess(access: FolderAccess): Promise<boolean> {
    const kind = this.snapshot.mode.kind;
    if (kind === 'memory') return Promise.resolve(access === 'readwrite');
    const handle = this.storedHandle;
    if (kind !== 'folder' || !handle) return Promise.resolve(false);
    if (access === this.accessState) return Promise.resolve(true);
    if (access === 'readwrite') {
      const permission = folderPermission(handle, true, 'readwrite'); // FIRST
      const refused = () => {
        this.set({ notice: 'The browser did not allow writing to the folder, so it stays read-only.' });
        return false;
      };
      return permission.then(async (state) => {
        if (state !== 'granted') return refused();
        // Unlinked or re-linked while the prompt was open: nothing to upgrade.
        if (this.snapshot.mode.kind !== 'folder' || this.storedHandle !== handle) return false;
        this.accessState = 'readwrite';
        await this.store.set(FOLDER_ACCESS_KEY, 'readwrite').catch(() => {});
        this.set({ folderAccess: 'readwrite' });
        return true;
      }, refused);
    }
    // Behind everything already queued: a save issued before the switch
    // still lands; writes issued after it are refused.
    return this.run(async () => {
      if (this.storedHandle !== handle) return false;
      this.accessState = 'read';
      await this.store.set(FOLDER_ACCESS_KEY, 'read').catch(() => {});
      this.set({ folderAccess: 'read' });
      return true;
    }, { write: false });
  }

  /**
   * `setAccess('readwrite')` — kept from 0.0.1. Since 0.0.4 the upgrade is
   * PERSISTED for this folder (it used to last for the session only).
   */
  requestWriteAccess(): Promise<boolean> {
    return this.setAccess('readwrite');
  }

  /**
   * Re-read the linked folder (after a change made outside the app). Ids of
   * unchanged paths are kept, and an unchanged folder keeps the SAME tree
   * object, so nothing downstream re-renders or re-prunes. Throttled, and
   * never concurrent with another rescan (FB-05 / FB-25).
   */
  rescan(options: { force?: boolean } = {}): Promise<void> {
    if (this.rescanning) return Promise.resolve();
    if (!options.force && Date.now() - this.lastRescanAt < MIN_RESCAN_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.rescanning = true;
    return this.run(async () => {
      if (!(this.backend instanceof FolderBackend) || this.mode.kind !== 'folder') return;
      const previous = this.tree;
      const { tree } = await scanFolder(this.backend.root, previous, this.scanOptions);
      this.lastRescanAt = Date.now();
      if (serializeTree(tree) === serializeTree(previous)) return;
      this.set({ tree });
    }, { write: false }).finally(() => {
      this.rescanning = false;
    });
  }

  // ── link / unlink ─────────────────────────────────────────────────────

  /**
   * LINK: the in-memory library is DISCARDED and the folder becomes the
   * library (ruling: "Linking back discards in memory tree and loads
   * folder"). The caller confirms with the user first. The handle is
   * persisted before the mode switches, so a failure part-way cannot leave
   * a linked-looking library that forgets its folder on reload.
   */
  link(handle: FileSystemDirectoryHandle, options: { access?: FolderAccess } = {}): Promise<void> {
    const access = options.access ?? this.defaultAccess;
    return this.run(async () => {
      // The picker already granted access; query first so no second prompt
      // appears, and request only if the picker did not.
      let permission = await folderPermission(handle, false, access);
      if (permission !== 'granted') permission = await folderPermission(handle, true, access);
      if (permission !== 'granted') {
        throw new LibraryError(
          access === 'read'
            ? 'The browser did not grant access to the folder.'
            : 'The browser did not grant write access to the folder.',
        );
      }
      await this.store.set(FOLDER_HANDLE_KEY, handle);
      await this.store.set(FOLDER_ACCESS_KEY, access);
      await this.attachFolder(handle, access);
      await this.memory.clear();
      this.lastDelete = null;
      this.set({ undoableDelete: null });
    });
  }

  /** What the tree holds, for the link confirm. */
  unlinkSummary(): { folders: number; openable: number; otherFiles: number } {
    return countContents(this.tree, this.policy);
  }

  /**
   * What UNLINK would do, measured: counts, the total size KEEP would copy
   * (file sizes are read from the folder's metadata, not the files), and
   * the site's free storage. Show it BEFORE asking KEEP or REMOVE.
   */
  planUnlink(): Promise<UnlinkPlan> {
    return this.run(async () => {
      const counts = countContents(this.tree, this.policy);
      const mode = this.snapshot.mode;
      const folderName = mode.kind === 'folder' || mode.kind === 'reconnect' ? mode.folderName : '';
      const keep = { folders: counts.folders, files: 0, bytes: 0, leftOnDisk: 0, unreadable: 0 };
      if (mode.kind !== 'folder') {
        return { mode: 'forget', folderName, ...counts, keep: { ...keep, folders: 0 }, storage: null, fits: null };
      }
      for (const node of Object.values(this.tree.nodes)) {
        if (node.kind !== 'file') continue;
        if (!this.policy.copyOnUnlink(node)) {
          keep.leftOnDisk += 1;
          continue;
        }
        try {
          keep.bytes += (await this.backend.getFile(this.tree, node.id)).size;
          keep.files += 1;
        } catch {
          keep.unreadable += 1;
        }
      }
      const storage = await estimateStorage();
      return {
        mode: 'folder',
        folderName,
        ...counts,
        keep,
        storage,
        fits: storage ? keep.bytes <= storage.available : null,
      };
    }, { write: false });
  }

  /**
   * UNLINK — forget the linked folder. Nothing on disk is touched.
   *
   *  - `keep: true` (KEEP): every folder and every file the policy's
   *    `copyOnUnlink` allows is copied into the browser first. Binary
   *    contents STREAM into the blob store (OPFS), never through memory;
   *    text is stored as strings. All-or-nothing: if the copy fails, runs out
   *    of space or is cancelled (`signal`, `cancelUnlink()`), the partial
   *    copy is deleted and the folder stays linked, unchanged. Files that
   *    cannot be READ are skipped and reported in `notice`, not fatal. Ids
   *    are kept, so the open file stays open.
   *  - `keep: false` (REMOVE), or a folder awaiting reconnection: the
   *    in-browser library ends up empty — no leftover folders.
   *
   * Asks the browser to keep the site's storage persistent before a copy.
   */
  unlink(options: UnlinkOptions): Promise<UnlinkResult> {
    const controller = new AbortController();
    this.unlinkController = controller;
    const signal = options.signal ? anySignal(options.signal, controller.signal) : controller.signal;
    return this.run(async () => {
      try {
        if (this.mode.kind !== 'folder' || !options.keep) {
          await this.forgetFolder();
          return { kept: 0, skipped: 0, bytes: 0 };
        }
        return await this.keepAndForget(signal, options.onProgress);
      } catch (error) {
        if (isAbort(error)) {
          this.set({ notice: 'Unlink cancelled: the folder is still linked and nothing was copied.' });
        }
        throw error;
      }
    }).finally(() => {
      if (this.unlinkController === controller) this.unlinkController = null;
      if (this.snapshot.unlinkProgress) this.set({ unlinkProgress: null });
    });
  }

  /** Cancel the KEEP copy in progress (the folder stays linked). */
  cancelUnlink(): void {
    this.unlinkController?.abort(new DOMException('The operation was cancelled.', 'AbortError'));
  }

  /** REMOVE: an empty in-browser library, the folder forgotten. */
  private async forgetFolder(): Promise<void> {
    await this.memory.clear();
    await this.memory.saveStructure(createEmptyTree());
    await this.store.delete(FOLDER_HANDLE_KEY);
    await this.store.delete(FOLDER_ACCESS_KEY).catch(() => {});
    this.storedHandle = null;
    this.backend = this.memory;
    this.accessState = this.defaultAccess;
    this.lastDelete = null;
    this.set({
      mode: { kind: 'memory' },
      tree: createEmptyTree(),
      folderAccess: null,
      unsupported: new Set(),
      undoableDelete: null,
    });
  }

  /**
   * KEEP. Measure, check the room, copy everything, and only then switch:
   * the structure is saved and the folder handle forgotten after the last
   * byte landed. Any failure before that deletes what was copied — the
   * folder stays linked and the browser's store stays empty, as it was
   * (LINK empties it). Everything is READ before the store is relied on: a
   * read failure part-way used to leave a wiped store (FB-17).
   */
  private async keepAndForget(
    signal: AbortSignal,
    onProgress: UnlinkOptions['onProgress'],
  ): Promise<UnlinkResult> {
    signal.throwIfAborted();
    const source = this.backend;
    const before = this.tree;
    let tree = before;
    for (const node of Object.values(before.nodes)) {
      if (node.kind === 'file' && !this.policy.copyOnUnlink(node) && tree.nodes[node.id]) {
        tree = removeNode(tree, node.id).tree;
      }
    }
    // Disk-backed Files: opening one reads nothing.
    const entries: { id: string; name: string; file: File }[] = [];
    let skipped = 0;
    for (const node of Object.values(tree.nodes)) {
      if (node.kind !== 'file') continue;
      try {
        entries.push({ id: node.id, name: node.name, file: await source.getFile(before, node.id) });
      } catch {
        skipped += 1;
        tree = removeNode(tree, node.id).tree;
      }
    }
    const progress: UnlinkProgress = {
      bytesCopied: 0,
      bytesTotal: entries.reduce((sum, entry) => sum + entry.file.size, 0),
      filesCopied: 0,
      filesTotal: entries.length,
      currentFile: null,
    };
    let lastReport = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
      lastReport = now;
      const copy = { ...progress };
      this.set({ unlinkProgress: copy });
      onProgress?.(copy);
    };
    report(true);

    const storage = await estimateStorage();
    if (storage && progress.bytesTotal > storage.available) {
      throw new LibraryError(
        `Not enough browser storage to keep a copy: it needs ${formatBytes(progress.bytesTotal)} and ${formatBytes(storage.available)} is free. Nothing was copied.`,
      );
    }
    if (progress.bytesTotal > 0) await requestPersistentStorage();
    signal.throwIfAborted();

    const blobs = this.memory.blobs;
    const streams = this.policy.content === 'binary' && blobs !== null;
    const inMemory = new Map<string, string | Blob>();
    try {
      await this.memory.clear(); // empty while linked; leftovers of a crash go
      const copyAll = async () => {
        for (const entry of entries) {
          signal.throwIfAborted();
          progress.currentFile = entry.name;
          report();
          const base = progress.bytesCopied;
          try {
            if (streams) {
              await this.memory.write(tree, entry.id, entry.file, {
                signal,
                onProgress: (written) => {
                  progress.bytesCopied = base + written;
                  report();
                },
              });
            } else if (this.policy.content === 'text') {
              inMemory.set(entry.id, await entry.file.text());
            } else {
              // No blob store (an in-memory library, or no OPFS): the store
              // holds Blobs, so this one is read like the store itself.
              inMemory.set(entry.id, new Blob([await entry.file.arrayBuffer()], { type: entry.file.type }));
            }
          } catch (error) {
            // The SOURCE could not be read (changed or removed meanwhile):
            // skip that file. Anything else — space, cancel — is fatal.
            if (signal.aborted || !isSourceReadError(error)) throw error;
            skipped += 1;
            tree = removeNode(tree, entry.id).tree;
            progress.bytesCopied = base;
            continue;
          }
          progress.bytesCopied = base + entry.file.size;
          progress.filesCopied += 1;
          report();
        }
      };
      if (streams) await withBlobLock(blobs!, 'shared', copyAll);
      else await copyAll();
      signal.throwIfAborted();
      progress.currentFile = null;
      report(true);
      for (const [id, data] of inMemory) await this.memory.write(tree, id, data);
      await this.memory.saveStructure(tree);
      await this.store.delete(FOLDER_HANDLE_KEY);
    } catch (error) {
      await this.memory.clear().catch(() => {});
      throw error;
    }
    await this.store.delete(FOLDER_ACCESS_KEY).catch(() => {});
    this.storedHandle = null;
    this.backend = this.memory;
    this.accessState = this.defaultAccess;
    this.lastDelete = null;
    this.set({
      mode: { kind: 'memory' },
      tree,
      folderAccess: null,
      undoableDelete: null,
      notice: skipped > 0 ? `${skipped} file(s) could not be read and were not copied.` : null,
    });
    return { kept: progress.filesCopied, skipped, bytes: progress.bytesCopied };
  }

  // ── files ─────────────────────────────────────────────────────────────

  /** The file as a `File`. From a linked folder it is the browser's
   *  disk-backed file, so `URL.createObjectURL(file)` streams even a huge
   *  video without reading it into memory. */
  getFile(id: string): Promise<File> {
    return this.run(() => this.backend.getFile(this.tree, id), { write: false });
  }

  /** The whole file as text — for small text documents. */
  readText(id: string): Promise<string> {
    return this.run(() => this.backend.readText(this.tree, id), { write: false });
  }

  /** Overwrite a file (text, bytes, or a stream). Rejects with
   *  `ConflictError` when a linked file changed on disk since it was read;
   *  pass `force` to overwrite anyway. `at` resumes an interrupted write. */
  write(
    id: string,
    data: WriteData,
    options?: Pick<WriteOptions, 'force' | 'at'>,
  ): Promise<void> {
    return this.run(async () => {
      this.assertWritable();
      if (!this.tree.nodes[id]) throw new LibraryError('That file no longer exists.');
      await this.backend.write(this.tree, id, data, options);
      if (this.snapshot.unsupported.has(id)) {
        const unsupported = new Set(this.snapshot.unsupported);
        unsupported.delete(id);
        this.set({ unsupported });
      }
    });
  }

  markUnsupported(id: string, isUnsupported: boolean): void {
    if (this.snapshot.unsupported.has(id) === isUnsupported) return;
    const unsupported = new Set(this.snapshot.unsupported);
    if (isUnsupported) unsupported.add(id);
    else unsupported.delete(id);
    this.set({ unsupported });
  }

  /** A name free both in the tree AND on disk (a linked folder may hold
   *  entries the last scan did not see, or hides). */
  private async freeName(parentId: string, desired: string): Promise<string> {
    const names = new Set(this.siblingNames(parentId));
    for (const name of await this.backend.namesIn(this.tree, parentId).catch(() => [])) {
      names.add(name);
    }
    return uniqueName(desired, names);
  }

  /** Create a file from `data` (text, bytes, or a stream); its name is made
   *  unique among siblings. */
  createFile(parentId: string, desiredName: string, data: WriteData): Promise<string> {
    return this.run(async () => {
      this.assertWritable();
      const name = await this.freeName(parentId, desiredName);
      const { tree, id } = addNode(this.tree, parentId, 'file', name);
      await this.backend.write(tree, id, data, { create: true });
      await this.backend.saveStructure(tree);
      this.set({ tree });
      return id;
    });
  }

  createFolder(parentId: string, desiredName: string): Promise<string> {
    return this.run(async () => {
      this.assertWritable();
      const name = await this.freeName(parentId, desiredName);
      const { tree, id } = addNode(this.tree, parentId, 'folder', name);
      await this.backend.createFolder(tree, id);
      await this.backend.saveStructure(tree);
      this.set({ tree });
      return id;
    });
  }

  async rename(id: string, name: string): Promise<void> {
    if (this.tree.nodes[id]) await this.beforeMutate(subtreeIds(this.tree, id));
    return this.run(async () => {
      this.assertWritable();
      const before = this.tree;
      const after = renameNode(before, id, name);
      if (after === before) return;
      const note = await this.backend.relocate(before, after, id);
      await this.backend.saveStructure(after);
      this.set({ tree: after, notice: note ?? this.snapshot.notice });
    });
  }

  /** Move several items into `targetParentId`. Selected descendants of a
   *  selected folder ride along with it rather than moving twice. */
  async move(ids: readonly string[], targetParentId: string): Promise<void> {
    const targets = topmostOnly(this.tree, ids);
    await this.beforeMutate(targets.flatMap((id) => subtreeIds(this.tree, id)));
    return this.run(async () => {
      this.assertWritable();
      for (const id of targets) {
        const before = this.tree;
        if (!before.nodes[id]) continue;
        const after = moveNode(before, id, targetParentId);
        if (after === before) continue;
        const note = await this.backend.relocate(before, after, id);
        await this.backend.saveStructure(after);
        this.set({ tree: after, notice: note ?? this.snapshot.notice });
      }
    });
  }

  /** Hidden entries (`.git`, dot-files, `node_modules`) a delete of these
   *  items would also remove — the tree does not show them. */
  async hiddenEntriesIn(ids: readonly string[]): Promise<number> {
    if (!(this.backend instanceof FolderBackend)) return 0;
    let total = 0;
    for (const id of topmostOnly(this.tree, ids)) {
      total += await this.backend.countHiddenEntries(this.tree, id);
    }
    return total;
  }

  /**
   * Delete, keeping enough to UNDO it this session (ruling F6: permanent
   * with confirm + session undo). Graph files and folders are restorable;
   * non-JSON files in a linked folder are not held in memory and are gone.
   * If a folder delete fails part-way, the tree is re-read from disk so it
   * matches what is really there (FB-10).
   */
  async remove(ids: readonly string[]): Promise<void> {
    const targets = topmostOnly(this.tree, ids);
    if (targets.length === 0) return;
    await this.beforeMutate(targets.flatMap((id) => subtreeIds(this.tree, id)));
    return this.run(async () => {
      this.assertWritable();
      const present = targets.filter((id) => this.tree.nodes[id]);
      if (present.length === 0) return;
      const record: DeletedSubtree = {
        label:
          present.length === 1
            ? `"${this.tree.nodes[present[0]].name}"`
            : `${present.length} items`,
        items: [],
      };
      let hadFiles = false;
      for (const id of present) {
        for (const itemId of subtreeIds(this.tree, id)) {
          const node = this.tree.nodes[itemId];
          const path = pathOf(this.tree, itemId);
          if (node.kind === 'folder') {
            record.items.push({ path, kind: 'folder' });
            continue;
          }
          hadFiles = true;
          if (this.policy.keepForUndo(node)) {
            const data = await this.readForCopy(this.backend, this.tree, itemId).catch(
              () => undefined,
            );
            record.items.push({ path, kind: 'file', data });
          }
        }
      }
      const notes: string[] = [];
      try {
        for (const id of present) {
          const before = this.tree;
          const note = await this.backend.remove(before, id);
          if (note) notes.push(note);
          const { tree } = removeNode(before, id);
          await this.backend.saveStructure(tree);
          this.set({ tree });
        }
      } catch (error) {
        if (this.backend instanceof FolderBackend) {
          const { tree } = await scanFolder(this.backend.root, this.tree, this.scanOptions).catch(() => ({
            tree: this.tree,
            unreadable: 0,
          }));
          this.set({ tree });
        }
        throw error;
      }
      if (notes.length > 0) {
        // Something stayed on disk; a re-scan shows what really remains.
        if (this.backend instanceof FolderBackend) {
          const { tree } = await scanFolder(this.backend.root, this.tree, this.scanOptions);
          this.set({ tree });
        }
        this.set({ notice: notes.join(' ') });
      }
      // Offer Undo only when it would bring the delete back: files whose
      // contents were kept, or a delete of folders alone. Deleted files of
      // which nothing was kept (videos) make Undo a lie — not offered.
      const restorable =
        record.items.some((item) => item.kind === 'file' && item.data !== undefined) || !hadFiles;
      this.lastDelete = restorable ? record : null;
      this.set({ undoableDelete: restorable ? record.label : null });
    });
  }

  /** Put the last delete back, at the same paths (names made unique if
   *  something took their place meanwhile). Returns the restored ids. */
  undoDelete(): Promise<string[]> {
    return this.run(async () => {
      this.assertWritable();
      const record = this.lastDelete;
      if (!record) return [];
      const restored: string[] = [];
      const idByPath = new Map<string, string>();
      for (const item of record.items) {
        const parentSegments = item.path.slice(0, -1);
        const parentKey = parentSegments.join('/');
        const parentId =
          idByPath.get(parentKey) ??
          findByPath(this.tree, parentSegments)?.id ??
          this.tree.rootId;
        const wanted = item.path[item.path.length - 1];
        const existing = childNamed(this.tree, parentId, wanted);
        if (item.kind === 'folder' && existing?.kind === 'folder') {
          idByPath.set(item.path.join('/'), existing.id);
          continue;
        }
        if (item.kind === 'file' && item.data === undefined) continue;
        const name = await this.freeName(parentId, wanted);
        const { tree, id } = addNode(this.tree, parentId, item.kind, name);
        if (item.kind === 'folder') await this.backend.createFolder(tree, id);
        else await this.backend.write(tree, id, item.data as string | Blob, { create: true });
        await this.backend.saveStructure(tree);
        this.set({ tree });
        idByPath.set(item.path.join('/'), id);
        restored.push(id);
      }
      this.lastDelete = null;
      this.set({ undoableDelete: null });
      return restored;
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private get scanOptions() {
    return { isHidden: this.policy.isHidden };
  }

  private folderBackend(handle: FileSystemDirectoryHandle): FolderBackend {
    return new FolderBackend(handle, this.scanOptions);
  }

  /**
   * Contents kept so a DELETE can be undone. Text policies keep strings, the
   * stored format Nodestra's libraries already hold. Binary contents (only
   * when a custom policy's `keepForUndo` asks) are read into memory: a
   * disk-backed File becomes unreadable once its file is gone.
   */
  private async readForCopy(
    backend: LibraryBackend,
    tree: LibraryTree,
    id: string,
  ): Promise<string | Blob> {
    if (this.policy.content === 'text') return backend.readText(tree, id);
    const file = await backend.getFile(tree, id);
    return new Blob([await file.arrayBuffer()], { type: file.type });
  }

  private siblingNames(parentId: string): string[] {
    getNode(this.tree, parentId);
    return (this.tree.children[parentId] ?? []).map((id) => this.tree.nodes[id].name);
  }

  private assertWritable(): void {
    if (this.writable) return;
    throw new LibraryError(
      this.mode.kind === 'reconnect'
        ? 'Reconnect the folder before changing it.'
        : this.mode.kind === 'folder'
          ? 'This folder is open read-only. Switch it to Read & write to change it.'
          : 'The library is still loading.',
    );
  }
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError'
  );
}

/** The source of a copy could not be read: changed or removed meanwhile. */
function isSourceReadError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotReadableError' || error.name === 'NotFoundError')
  );
}

/** Either signal aborts the result. */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any.call(AbortSignal, [a, b]);
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function describe(error: unknown): string {
  if (error instanceof LibraryError) return error.message;
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'The browser refused access to the folder. Reconnect it to continue.';
      case 'NotFoundError':
        return 'That item is no longer on disk — it may have been moved outside the app.';
      case 'QuotaExceededError':
        return 'The browser is out of storage space for the library.';
      case 'NoModificationAllowedError':
        return 'The file is locked by another program or tab.';
      case 'TypeMismatchError':
        return 'A file and a folder have the same name there.';
      case 'InvalidModificationError':
        return 'That folder is not empty or is in use, so it could not be changed.';
      case 'AbortError':
        return 'The operation was cancelled.';
      default:
        break;
    }
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export { FileLibrary };
export type {
  FileLibraryOptions,
  LibraryMode,
  LibrarySnapshot,
  UnlinkOptions,
  UnlinkPlan,
  UnlinkProgress,
  UnlinkResult,
};
