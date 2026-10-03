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
};

/** What a delete removed, enough to put it back (kept files and folders). */
type DeletedSubtree = {
  label: string;
  items: { path: string[]; kind: 'folder' | 'file'; data?: string | Blob }[];
};

const FOLDER_HANDLE_KEY = 'folderHandle';
const INITIALIZED_KEY = 'initialized';

/** Re-scans triggered by window focus are cheap only when rare. */
const MIN_RESCAN_INTERVAL_MS = 2000;

type FileLibraryOptions = {
  store: KeyValueStore;
  /** Which files the app opens and how their contents may be handled. */
  policy: FilePolicy;
  /** What a linked folder may do. `'read'` asks the browser for read access
   *  only and refuses every change (create, rename, move, delete, write).
   *  Default `'readwrite'`. */
  access?: FolderAccess;
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
  beforeMutate: (affectedIds: readonly string[]) => Promise<void>;
  readonly policy: FilePolicy;
  /** What the linked folder may do now. Starts as the `access` option; a
   *  read-only link can be upgraded with `requestWriteAccess()`. */
  get access(): FolderAccess {
    return this.accessState;
  }
  private accessState: FolderAccess;

  constructor(options: FileLibraryOptions) {
    this.store = options.store;
    this.policy = options.policy;
    this.accessState = options.access ?? 'readwrite';
    this.memory = new MemoryBackend(this.store);
    this.backend = this.memory;
    this.beforeMutate = options.beforeMutate ?? (async () => {});
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
      if (!(error instanceof ConflictError)) {
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
      this.memory = new MemoryBackend(this.store);
      this.backend = this.memory;
      this.set({ storageUnavailable: true });
    }
    const handle = await this.store
      .get<FileSystemDirectoryHandle>(FOLDER_HANDLE_KEY)
      .catch(() => undefined);
    if (handle && canLinkFolders()) {
      this.storedHandle = handle;
      const permission = await folderPermission(handle, false, this.access).catch(
        () => 'denied' as PermissionState,
      );
      if (permission === 'granted') {
        try {
          await this.attachFolder(handle);
          return;
        } catch {
          // Moved or deleted outside the app: fall through to "reconnect".
        }
      }
      this.backend = this.folderBackend(handle);
      this.set({ mode: { kind: 'reconnect', folderName: handle.name } });
      return;
    }
    const stored = await this.memory.loadStructure().catch(() => undefined);
    const tree = (stored && deserializeTree(stored)) || createEmptyTree();
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

  private async attachFolder(handle: FileSystemDirectoryHandle): Promise<void> {
    const { tree, unreadable } = await scanFolder(handle, undefined, this.scanOptions);
    this.backend = this.folderBackend(handle);
    this.storedHandle = handle;
    this.lastRescanAt = Date.now();
    this.set({
      mode: { kind: 'folder', folderName: handle.name },
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
   */
  reconnect(): Promise<void> {
    const handle = this.storedHandle;
    if (!handle) return Promise.reject(new LibraryError('No folder is linked.'));
    const permission = folderPermission(handle, true, this.access);
    return this.run(async () => {
      if ((await permission) !== 'granted') {
        throw new LibraryError('The browser did not grant access to the folder.');
      }
      await this.attachFolder(handle);
    }, { write: false });
  }

  /**
   * Upgrade a READ-ONLY link to read-write for the rest of the session — for
   * an app that only sometimes writes (watch-together saves a downloaded
   * copy). Same rule as `reconnect`: call it straight from a click; the
   * permission is requested FIRST, before anything that could outlive the
   * click's user activation. Resolves `true` when writing is now allowed.
   * After a reload the library starts from its `access` option again (the
   * browser may still remember the grant, so a later request is often
   * silent).
   */
  requestWriteAccess(): Promise<boolean> {
    if (this.accessState === 'readwrite' || this.snapshot.mode.kind === 'memory') {
      return Promise.resolve(this.writable);
    }
    const handle = this.storedHandle;
    if (!handle || this.snapshot.mode.kind !== 'folder') return Promise.resolve(false);
    const permission = folderPermission(handle, true, 'readwrite');
    return permission.then(
      (state) => {
        if (state !== 'granted') return false;
        this.accessState = 'readwrite';
        this.set({}); // `writable` changed: tell subscribers
        return true;
      },
      () => false,
    );
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
  link(handle: FileSystemDirectoryHandle): Promise<void> {
    return this.run(async () => {
      // The picker already granted access; query first so no second prompt
      // appears, and request only if the picker did not.
      let permission = await folderPermission(handle, false, this.access);
      if (permission !== 'granted') permission = await folderPermission(handle, true, this.access);
      if (permission !== 'granted') {
        throw new LibraryError(
          this.access === 'read'
            ? 'The browser did not grant access to the folder.'
            : 'The browser did not grant write access to the folder.',
        );
      }
      await this.store.set(FOLDER_HANDLE_KEY, handle);
      await this.attachFolder(handle);
      await this.memory.clear();
      this.lastDelete = null;
      this.set({ undoableDelete: null });
    });
  }

  /** What UNLINK would copy, for the confirm dialog. */
  unlinkSummary(): { folders: number; openable: number; otherFiles: number } {
    return countContents(this.tree, this.policy);
  }

  /**
   * UNLINK: copy the folder's structure and every file the policy's
   * `copyOnUnlink` allows into the browser, then forget the folder. Other
   * files stay on disk only (Nodestra ruling F4). Ids are kept, so the open
   * file stays open.
   *
   * Everything is READ first and only then is the browser's store replaced —
   * a read failure part-way used to leave an already-wiped store (FB-17).
   * Unreadable files are skipped and reported, not fatal.
   */
  unlink(): Promise<void> {
    return this.run(async () => {
      if (this.mode.kind !== 'folder') {
        // Nothing readable (reconnect pending): forget the folder.
        await this.store.delete(FOLDER_HANDLE_KEY);
        this.storedHandle = null;
        this.backend = this.memory;
        await this.memory.clear();
        await this.memory.saveStructure(createEmptyTree());
        this.set({ mode: { kind: 'memory' }, tree: createEmptyTree() });
        return;
      }
      const source = this.backend;
      const before = this.tree;
      let tree = before;
      for (const node of Object.values(before.nodes)) {
        if (node.kind === 'file' && !this.policy.copyOnUnlink(node) && tree.nodes[node.id]) {
          tree = removeNode(tree, node.id).tree;
        }
      }
      const contents = new Map<string, string | Blob>();
      let skipped = 0;
      for (const node of Object.values(tree.nodes)) {
        if (node.kind !== 'file') continue;
        try {
          contents.set(node.id, await this.readForCopy(source, before, node.id));
        } catch {
          skipped += 1;
          tree = removeNode(tree, node.id).tree;
        }
      }
      await this.memory.clear();
      for (const [id, data] of contents) await this.memory.write(tree, id, data);
      await this.memory.saveStructure(tree);
      await this.store.delete(FOLDER_HANDLE_KEY);
      this.storedHandle = null;
      this.backend = this.memory;
      this.set({
        mode: { kind: 'memory' },
        tree,
        notice:
          skipped > 0 ? `${skipped} file(s) could not be read and were not copied.` : null,
      });
    });
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
      for (const id of present) {
        for (const itemId of subtreeIds(this.tree, id)) {
          const node = this.tree.nodes[itemId];
          const path = pathOf(this.tree, itemId);
          if (node.kind === 'folder') {
            record.items.push({ path, kind: 'folder' });
          } else if (this.policy.keepForUndo(node)) {
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
      this.lastDelete = record;
      this.set({ undoableDelete: record.label });
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
   * Contents that must outlive their source (an unlinked folder, a deleted
   * file). Text policies keep strings, the stored format Nodestra's libraries
   * already hold. Binary contents are read into memory: a disk-backed File
   * becomes unreadable once its file is gone, so a reference is not enough.
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
          ? 'This folder is linked read-only.'
          : 'The library is still loading.',
    );
  }
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
export type { FileLibraryOptions, LibraryMode, LibrarySnapshot };
