/**
 * Where the library's bytes live. Two backends, one contract:
 *
 *  - MemoryBackend: the browser's own storage (IndexedDB). The tree structure
 *    is one key, each file's contents another (a string, or a Blob for
 *    binary data). With a `BlobStore` (OPFS), binary contents go there
 *    instead, streamed, never through memory. Survives a reload (Nodestra
 *    ruling F2).
 *  - FolderBackend: a real folder the user linked with the File System Access
 *    API. Every operation is mirrored to disk; the tree is re-read from disk.
 *
 * Every mutating call receives the tree BEFORE and/or AFTER the change, so
 * the backend can derive both paths itself. Ids never reach the disk.
 *
 * BINARY SAFETY. Nothing here reads a whole file unless asked to:
 * `getFile` returns the browser's disk-backed `File` (an object URL made from
 * it streams a 4 GB video without loading it), `write` accepts a stream, and
 * folder moves copy file by file through streams.
 */

import { isHiddenEntry, nameKey, sameName } from './names';
import {
  getNode,
  LibraryError,
  newNodeId,
  pathOf,
  serializeTree,
  subtreeIds,
  treeFromNodes,
} from './libraryTree';
import type { LibraryNode, LibraryTree } from './libraryTree';
import type { KeyValueStore } from './keyValueStore';
import { mediaTypeOf, withBlobLock } from './blobStore';
import type { BlobStore } from './blobStore';

type BackendKind = 'memory' | 'folder';

/** What a linked folder may do: a video library only reads. */
type FolderAccess = 'read' | 'readwrite';

/** Anything a file can be written from. A stream is consumed as it arrives. */
type WriteData =
  | string
  | Blob
  | ArrayBuffer
  | ArrayBufferView<ArrayBuffer>
  | ReadableStream<Uint8Array>;

type WriteOptions = {
  /** Skip the folder backend's "changed on disk since we last saw it" check
   *  (see `ConflictError`). */
  force?: boolean;
  /** Make a NEW file; refuses to replace anything already on disk (the tree
   *  only knows what the last scan saw). */
  create?: boolean;
  /** Write starting at this byte offset, keeping the bytes before it — how
   *  an interrupted download resumes. */
  at?: number;
  /** Abort a streamed write; the previous contents stay. */
  signal?: AbortSignal;
  /** Bytes written by this call so far, as chunks land. */
  onProgress?(bytesWritten: number): void;
};

interface LibraryBackend {
  readonly kind: BackendKind;
  /** The file's contents as a `File`. From a folder this is the browser's
   *  disk-backed file: nothing is read until it is. */
  getFile(tree: LibraryTree, id: string): Promise<File>;
  /** The whole file as text — for small text documents only. */
  readText(tree: LibraryTree, id: string): Promise<string>;
  /** Overwrite an existing file, or — with `create` — make a new one. */
  write(tree: LibraryTree, id: string, data: WriteData, options?: WriteOptions): Promise<void>;
  createFolder(tree: LibraryTree, id: string): Promise<void>;
  /** Rename and/or move `id`: its path in `before` → its path in `after`.
   *  Resolves to a note for the user when part of it could not be done. */
  relocate(before: LibraryTree, after: LibraryTree, id: string): Promise<string | null>;
  /** Delete `id` (and everything under it) as it is in `before`. Resolves
   *  to a note for the user when something had to be left behind. */
  remove(before: LibraryTree, id: string): Promise<string | null>;
  /** Persist the STRUCTURE after a change. Memory only; a folder IS its
   *  structure. */
  saveStructure(tree: LibraryTree): Promise<void>;
  /** Every name currently in `parentId` — on DISK for a folder (hidden and
   *  unlisted entries included where the browser shows them). */
  namesIn(tree: LibraryTree, parentId: string): Promise<string[]>;
}

/** The file changed on disk after we last read or wrote it. */
class ConflictError extends Error {
  constructor(readonly fileName: string) {
    super(`"${fileName}" was changed outside the app since it was opened.`);
    this.name = 'ConflictError';
  }
}

// ─────────────────────────────── memory ────────────────────────────────

const TREE_KEY = 'tree';
const fileKey = (id: string) => `file:${id}`;

class MemoryBackend implements LibraryBackend {
  readonly kind = 'memory' as const;

  /** `blobs`: where BINARY contents go (OPFS in a browser). Without one,
   *  they are Blobs in the key-value store, as before 0.0.4. Text is always
   *  a string in the key-value store. */
  constructor(
    private readonly store: KeyValueStore,
    readonly blobs: BlobStore | null = null,
  ) {}

  /** Contents: the key-value entry first (text, and Blobs stored before a
   *  blob store existed), then the blob store. */
  private async stored(id: string): Promise<string | Blob> {
    const value = await this.store.get<unknown>(fileKey(id));
    if (typeof value === 'string' || value instanceof Blob) return value;
    const file = await this.blobs?.get(id);
    if (file) return file;
    throw new LibraryError('This file has no stored content.');
  }

  /** A blob-store entry is the browser's disk-backed file, re-wrapped only
   *  to carry the library name (a File made from a File references it; no
   *  bytes are copied). */
  async getFile(tree: LibraryTree, id: string): Promise<File> {
    const value = await this.stored(id);
    const name = tree.nodes[id]?.name ?? id;
    if (typeof value === 'string') return new File([value], name);
    return new File([value], name, {
      type: value.type || mediaTypeOf(name),
      lastModified: value instanceof File ? value.lastModified : undefined,
    });
  }

  async readText(_tree: LibraryTree, id: string): Promise<string> {
    const value = await this.stored(id);
    return typeof value === 'string' ? value : value.text();
  }

  /** Text stays a string (the format Nodestra's stored libraries already
   *  hold). Anything else streams into the blob store when there is one, or
   *  is kept as a Blob, which IndexedDB stores natively. */
  async write(
    _tree: LibraryTree,
    id: string,
    data: WriteData,
    options: WriteOptions = {},
  ): Promise<void> {
    const blobs = this.blobs;
    if (blobs && typeof data !== 'string') {
      await withBlobLock(blobs, 'shared', async () => {
        if (options.at !== undefined) {
          // Resuming a file whose head is still in the key-value store
          // (written before the blob store existed): move the head first.
          const legacy = await this.store.get<unknown>(fileKey(id));
          if (typeof legacy === 'string' || legacy instanceof Blob) await blobs.put(id, legacy);
        }
        await blobs.put(id, data, {
          at: options.at,
          signal: options.signal,
          onProgress: options.onProgress,
        });
      });
      await this.store.delete(fileKey(id));
      return;
    }
    let value: string | Blob = typeof data === 'string' ? data : await toBlob(data);
    if (options.at !== undefined) {
      const existing = await this.stored(id).catch(() => '');
      const head = new Blob([existing]).slice(0, options.at);
      value = new Blob([head, value]);
    }
    await this.store.set(fileKey(id), value);
    if (blobs) await blobs.delete(id);
  }

  async createFolder(_tree: LibraryTree, _id: string): Promise<void> {}

  async relocate(
    _before: LibraryTree,
    _after: LibraryTree,
    _id: string,
  ): Promise<string | null> {
    // Contents are keyed by id, which does not change; the structure write
    // that follows every operation records the new place.
    return null;
  }

  /** Removes the contents too — a blob-store file's bytes are freed now. */
  async remove(before: LibraryTree, id: string): Promise<string | null> {
    for (const gone of subtreeIds(before, id)) {
      if (before.nodes[gone].kind !== 'file') continue;
      await this.store.delete(fileKey(gone));
      await this.blobs?.delete(gone);
    }
    return null;
  }

  async saveStructure(tree: LibraryTree): Promise<void> {
    await this.store.set(TREE_KEY, serializeTree(tree));
  }

  async namesIn(tree: LibraryTree, parentId: string): Promise<string[]> {
    return (tree.children[parentId] ?? []).map((id) => tree.nodes[id].name);
  }

  /** The stored structure, if any. */
  async loadStructure(): Promise<string | undefined> {
    return this.store.get<string>(TREE_KEY);
  }

  /** Forget every file and the structure (RE-LINK discards memory). */
  async clear(): Promise<void> {
    for (const key of await this.store.keys()) {
      if (key === TREE_KEY || key.startsWith('file:')) await this.store.delete(key);
    }
    const blobs = this.blobs;
    if (blobs) for (const key of await blobs.keys()) await blobs.delete(key);
  }

  /**
   * Delete blob-store entries no file of the library refers to — left by a
   * tab closed in the middle of a copy. Only when no other tab holds the
   * store's lock (it may be writing), and never an entry changed in the
   * last `graceMs` (written by a tab whose structure write is still on its
   * way). Resolves how many entries were removed.
   */
  async sweep(referenced: ReadonlySet<string>, graceMs = 60_000): Promise<number> {
    const blobs = this.blobs;
    if (!blobs) return 0;
    const removed = await withBlobLock(
      blobs,
      'exclusive',
      async () => {
        let count = 0;
        for (const key of await blobs.keys()) {
          if (referenced.has(key)) continue;
          const file = await blobs.get(key).catch(() => undefined);
          if (file && Date.now() - file.lastModified < graceMs) continue;
          await blobs.delete(key).then(
            () => (count += 1),
            () => {},
          );
        }
        return count;
      },
      true,
    );
    return removed ?? 0;
  }
}

// ─────────────────────────────── folder ────────────────────────────────

async function directoryAt(
  root: FileSystemDirectoryHandle,
  segments: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment);
  }
  return current;
}

/** Every name the browser lists in `directory`. */
async function listNames(directory: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const name of directory.keys()) names.push(name);
  return names;
}

/** Every [name, handle] the browser lists, collected before acting on any. */
async function listEntries(
  directory: FileSystemDirectoryHandle,
): Promise<[string, FileSystemHandle][]> {
  const entries: [string, FileSystemHandle][] = [];
  for await (const entry of directory.entries()) entries.push(entry);
  return entries;
}

/** Does `parent` already contain `name` — file OR folder, any case? Hidden
 *  entries (`.git`) are not in the tree, so the tree's own check misses them. */
async function diskHasName(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<string | undefined> {
  for (const existing of await listNames(parent)) {
    if (sameName(existing, name)) return existing;
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function isStream(data: WriteData): data is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && data instanceof ReadableStream;
}

async function toBlob(data: Exclude<WriteData, string>): Promise<Blob> {
  if (isStream(data)) return new Response(data).blob();
  return data instanceof Blob ? data : new Blob([data]);
}

/**
 * Write `data` through ONE writable: replace the file, or (with `at`) keep
 * the first `at` bytes and write from there. A stream is piped, so memory
 * holds only the chunk in flight. The browser commits its swap file on
 * close, so a failure part-way leaves the previous contents untouched.
 */
async function writeWhole(
  handle: FileSystemFileHandle,
  data: WriteData,
  at?: number,
  options: Pick<WriteOptions, 'signal' | 'onProgress'> = {},
) {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('The operation was cancelled.', 'AbortError');
  }
  const writable = await handle.createWritable({ keepExistingData: at !== undefined });
  try {
    if (at !== undefined) await writable.seek(at);
    if (isStream(data) || options.signal || options.onProgress) {
      const source = isStream(data) ? data : (new Blob([data]).stream() as ReadableStream<Uint8Array>);
      let written = 0;
      const counted = options.onProgress
        ? source.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                written += chunk.byteLength;
                options.onProgress?.(written);
                controller.enqueue(chunk);
              },
            }),
          )
        : source;
      // pipeTo closes the writable on success and aborts it on failure.
      await counted.pipeTo(writable, { signal: options.signal });
      return;
    }
    await writable.write(data);
    await writable.close();
  } catch (error) {
    // An unclosed writable keeps the file locked and its swap file on disk.
    await writable.abort().catch(() => {});
    throw error;
  }
}

/** Copy one file through a stream — never the whole file in memory. */
async function copyFile(
  source: FileSystemFileHandle,
  destinationParent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const file = await source.getFile();
  const target = await destinationParent.getFileHandle(name, { create: true });
  await writeWhole(target, file.stream());
}

type CopyReport = { copied: number; failed: number };

/**
 * Copy what the browser LISTS in `source`. Chrome's listing silently omits
 * names it will not expose to websites (`.lnk`, `.url`, `.scf`, dangerous
 * executables, `~`-names, invisible characters — Chromium
 * `DidReadDirectory` skips any child failing `IsSafePathComponent`), so this
 * copy can never be assumed complete. See `drainCopiedDirectory`.
 */
async function copyDirectory(
  source: FileSystemDirectoryHandle,
  destinationParent: FileSystemDirectoryHandle,
  name: string,
  report: CopyReport,
): Promise<void> {
  const target = await destinationParent.getDirectoryHandle(name, { create: true });
  for await (const [childName, child] of source.entries()) {
    try {
      if (child.kind === 'file') {
        await copyFile(child as FileSystemFileHandle, target, childName);
      } else {
        await copyDirectory(child as FileSystemDirectoryHandle, target, childName, report);
        continue; // counted inside
      }
      report.copied += 1;
    } catch (error) {
      report.failed += 1;
      throw error;
    }
  }
}

/**
 * Remove from `source` ONLY what exists in `copy`, bottom-up, and remove a
 * directory only if it ended up EMPTY (never `recursive: true`). Returns how
 * many entries had to be left behind.
 *
 * WHY NOT `removeEntry(source, { recursive: true })`: that is an OS-level
 * recursive delete, and it deletes the entries the browser never listed —
 * files the copy therefore never made. Measured cause: FB-01 in
 * review/2026-09-26-library. With this drain, anything invisible to the app
 * stays exactly where it was, in the old folder, and the user is told.
 */
async function drainCopiedDirectory(
  source: FileSystemDirectoryHandle,
  copy: FileSystemDirectoryHandle,
): Promise<number> {
  let leftBehind = 0;
  // Snapshot first: removing entries while iterating the same directory can
  // make the iterator skip siblings.
  for (const [childName, child] of await listEntries(source)) {
    try {
      if (child.kind === 'file') {
        await copy.getFileHandle(childName); // throws if the copy lacks it
        await source.removeEntry(childName);
      } else {
        const copiedDirectory = await copy.getDirectoryHandle(childName);
        const kept = await drainCopiedDirectory(
          child as FileSystemDirectoryHandle,
          copiedDirectory,
        );
        leftBehind += kept;
        if (kept === 0) await source.removeEntry(childName).catch(() => {
          leftBehind += 1;
        });
      }
    } catch {
      leftBehind += 1;
    }
  }
  return leftBehind;
}

/**
 * Delete everything the browser lists under `directory`, bottom-up, and the
 * directory itself only if it is then empty. Returns how many entries were
 * left behind (ones the browser does not list, or refuses to delete).
 */
async function drainDirectory(directory: FileSystemDirectoryHandle): Promise<number> {
  let leftBehind = 0;
  for (const [childName, child] of await listEntries(directory)) {
    try {
      if (child.kind === 'file') {
        await directory.removeEntry(childName);
      } else {
        const kept = await drainDirectory(child as FileSystemDirectoryHandle);
        leftBehind += kept;
        if (kept === 0) await directory.removeEntry(childName);
      }
    } catch {
      leftBehind += 1;
    }
  }
  return leftBehind;
}

/** Is `directory` empty as far as the OS is concerned? The browser listing
 *  can omit entries, so "nothing listed" is not proof; a non-recursive
 *  removal attempt is. */
async function removeIfEmpty(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await parent.removeEntry(name);
    return true;
  } catch {
    return false;
  }
}

/** A name no sibling has — the intermediate step of a case-only rename. */
function temporaryName(name: string): string {
  return `${name}.renaming-${Math.random().toString(36).slice(2, 8)}`;
}

type Seen = { lastModified: number; size: number };

class FolderBackend implements LibraryBackend {
  readonly kind = 'folder' as const;
  /** What each file was when we last read or wrote it — the conflict check.
   *  Size as well as time: an outside edit can carry an OLDER timestamp
   *  (a restore, a sync client, a copy with preserved times). */
  private readonly seen = new Map<string, Seen>();

  private readonly isHidden: (name: string) => boolean;

  constructor(
    readonly root: FileSystemDirectoryHandle,
    options: { isHidden?: (name: string) => boolean } = {},
  ) {
    this.isHidden = options.isHidden ?? isHiddenEntry;
  }

  get folderName(): string {
    return this.root.name;
  }

  private async parentOf(tree: LibraryTree, id: string) {
    const segments = pathOf(tree, id);
    const name = segments[segments.length - 1];
    const parent = await directoryAt(this.root, segments.slice(0, -1));
    return { parent, name };
  }

  private async remember(id: string, handle: FileSystemFileHandle) {
    const file = await handle.getFile();
    this.seen.set(id, { lastModified: file.lastModified, size: file.size });
  }

  async getFile(tree: LibraryTree, id: string): Promise<File> {
    const { parent, name } = await this.parentOf(tree, id);
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    this.seen.set(id, { lastModified: file.lastModified, size: file.size });
    return file;
  }

  async readText(tree: LibraryTree, id: string): Promise<string> {
    return (await this.getFile(tree, id)).text();
  }

  async write(
    tree: LibraryTree,
    id: string,
    data: WriteData,
    options: WriteOptions = {},
  ): Promise<void> {
    const { parent, name } = await this.parentOf(tree, id);
    let handle: FileSystemFileHandle;
    if (options.create) {
      // Never over an entry the tree did not know about (made by another
      // program since the last scan, or hidden from the listing).
      const clash = await diskHasName(parent, name);
      if (clash !== undefined) {
        throw new LibraryError(`"${clash}" already exists in that folder on disk.`);
      }
      handle = await parent.getFileHandle(name, { create: true });
    } else {
      try {
        handle = await parent.getFileHandle(name);
      } catch (error) {
        // Only a genuinely missing file is re-created (deleted outside the
        // app while open). Any other failure — a folder of that name, a
        // lock, a revoked permission — is a real error, not "new".
        if (!isNotFound(error)) throw error;
        const clash = await diskHasName(parent, name);
        if (clash !== undefined) {
          throw new LibraryError(`"${clash}" already exists in that folder on disk.`);
        }
        handle = await parent.getFileHandle(name, { create: true });
      }
      const known = this.seen.get(id);
      if (!options.force && known !== undefined) {
        const current = await handle.getFile();
        if (current.lastModified !== known.lastModified || current.size !== known.size) {
          throw new ConflictError(name);
        }
      }
    }
    await writeWhole(handle, data, options.at, options);
    await this.remember(id, handle);
  }

  async createFolder(tree: LibraryTree, id: string): Promise<void> {
    const { parent, name } = await this.parentOf(tree, id);
    const clash = await diskHasName(parent, name);
    if (clash !== undefined) {
      throw new LibraryError(`"${clash}" already exists in that folder on disk.`);
    }
    await parent.getDirectoryHandle(name, { create: true });
  }

  async namesIn(tree: LibraryTree, parentId: string): Promise<string[]> {
    const segments = pathOf(tree, parentId);
    return listNames(await directoryAt(this.root, segments));
  }

  async relocate(
    before: LibraryTree,
    after: LibraryTree,
    id: string,
  ): Promise<string | null> {
    const node = getNode(before, id);
    const from = await this.parentOf(before, id);
    const to = await this.parentOf(after, id);
    const sameParent = (await from.parent.isSameEntry(to.parent)) === true;
    const caseOnly = sameParent && sameName(from.name, to.name);
    if (!caseOnly) {
      const clash = await diskHasName(to.parent, to.name);
      if (clash !== undefined) {
        throw new LibraryError(`"${clash}" already exists in that folder on disk.`);
      }
    }

    if (node.kind === 'file') {
      const handle = await from.parent.getFileHandle(from.name);
      if (caseOnly) {
        // One step would be a no-op on a case-insensitive disk; go via a
        // temporary name that cannot collide.
        const temp = temporaryName(from.name);
        await this.moveFile(handle, from.parent, from.name, to.parent, temp);
        const tempHandle = await to.parent.getFileHandle(temp);
        await this.moveFile(tempHandle, to.parent, temp, to.parent, to.name);
      } else {
        await this.moveFile(handle, from.parent, from.name, to.parent, to.name);
      }
      await this.remember(id, await to.parent.getFileHandle(to.name));
      return null;
    }

    // Directories cannot be moved or renamed natively in any shipping browser
    // (`FileSystemDirectoryHandle.prototype.move` is undefined in stable
    // Chrome). Copy, then remove from the original ONLY what the copy
    // verifiably holds — never a recursive delete (see drainCopiedDirectory).
    const source = await from.parent.getDirectoryHandle(from.name);
    const stagingName = caseOnly ? temporaryName(from.name) : to.name;
    const report: CopyReport = { copied: 0, failed: 0 };
    try {
      await copyDirectory(source, to.parent, stagingName, report);
    } catch (error) {
      // Undo the partial copy the same careful way: only what we made.
      const partial = await to.parent
        .getDirectoryHandle(stagingName)
        .catch(() => undefined);
      if (partial) {
        await drainDirectory(partial);
        await removeIfEmpty(to.parent, stagingName);
      }
      throw error;
    }
    const staged = await to.parent.getDirectoryHandle(stagingName);
    let leftBehind = await drainCopiedDirectory(source, staged);
    if (leftBehind === 0 && !(await removeIfEmpty(from.parent, from.name))) {
      // The listing showed nothing more, yet the OS says it is not empty:
      // entries the browser hides. They stay put.
      leftBehind = 1;
    }
    if (caseOnly) {
      if (leftBehind > 0) {
        // The original name is still taken by what was left behind; keep
        // the moved content under its temporary name rather than guess.
        throw new LibraryError(
          `Some items in "${from.name}" are hidden from websites and could not be moved; the rest is in "${stagingName}".`,
        );
      }
      const finalReport: CopyReport = { copied: 0, failed: 0 };
      await copyDirectory(staged, to.parent, to.name, finalReport);
      const final = await to.parent.getDirectoryHandle(to.name);
      await drainCopiedDirectory(staged, final);
      await removeIfEmpty(to.parent, stagingName);
    }
    // Every copied file was written just now: refresh the conflict records,
    // or the next save of each would falsely report "changed outside the
    // app" (FB-03).
    await this.rememberSubtree(after, id);
    return leftBehind > 0
      ? `${leftBehind} item(s) in "${from.name}" are hidden from websites by the browser and were left in the original folder, untouched.`
      : null;
  }

  private async rememberSubtree(tree: LibraryTree, id: string): Promise<void> {
    for (const itemId of subtreeIds(tree, id)) {
      if (tree.nodes[itemId].kind !== 'file') continue;
      const { parent, name } = await this.parentOf(tree, itemId);
      const handle = await parent.getFileHandle(name).catch(() => undefined);
      if (handle) await this.remember(itemId, handle);
    }
  }

  private async moveFile(
    handle: FileSystemFileHandle,
    fromParent: FileSystemDirectoryHandle,
    fromName: string,
    toParent: FileSystemDirectoryHandle,
    toName: string,
  ): Promise<void> {
    if (typeof handle.move === 'function') {
      try {
        await handle.move(toParent, toName);
        return;
      } catch {
        // Chrome Android and some edge cases refuse; fall back to a copy.
      }
    }
    await copyFile(handle, toParent, toName);
    await fromParent.removeEntry(fromName);
  }

  async remove(before: LibraryTree, id: string): Promise<string | null> {
    const node = getNode(before, id);
    const { parent, name } = await this.parentOf(before, id);
    for (const gone of subtreeIds(before, id)) this.seen.delete(gone);
    if (node.kind === 'file') {
      await parent.removeEntry(name);
      return null;
    }
    // Same rule as a move: only what the browser lists, never recursive.
    const directory = await parent.getDirectoryHandle(name);
    let leftBehind = await drainDirectory(directory);
    if (leftBehind === 0 && !(await removeIfEmpty(parent, name))) leftBehind = 1;
    return leftBehind > 0
      ? `"${name}" still holds ${leftBehind} item(s) the browser does not let websites see or delete; they were left on disk.`
      : null;
  }

  /** Hidden entries (dot-files, `node_modules`) inside `id`, which the tree
   *  does not show — so a delete can say it will remove them too. */
  async countHiddenEntries(tree: LibraryTree, id: string): Promise<number> {
    if (tree.nodes[id]?.kind !== 'folder') return 0;
    const count = async (directory: FileSystemDirectoryHandle): Promise<number> => {
      let hidden = 0;
      for await (const [name, child] of directory.entries()) {
        if (this.isHidden(name)) hidden += 1;
        else if (child.kind === 'directory') {
          hidden += await count(child as FileSystemDirectoryHandle);
        }
      }
      return hidden;
    };
    try {
      return await count(await directoryAt(this.root, pathOf(tree, id)));
    } catch {
      return 0;
    }
  }

  async saveStructure(_tree: LibraryTree): Promise<void> {}
}

// ─────────────────────────────── scanning ──────────────────────────────

type ScanResult = {
  tree: LibraryTree;
  /** Subfolders that could not be read (permissions, locks) — skipped. */
  unreadable: number;
};

/**
 * Read a linked folder into a tree. Hidden entries are skipped entirely;
 * every other file is included (non-JSON ones render greyed). Contents are
 * NOT read — a file's status is decided when it is opened.
 *
 * LINEAR: nodes are collected into plain maps and each folder's children are
 * sorted once at the end. Building it through `addNode` copied the whole node
 * map per entry — quadratic, and it froze the app on a large folder (FB-05).
 *
 * `previous`, when given, lends its ids to entries at the same path AND of
 * the same kind, so a re-scan keeps the open file, the selection and the
 * expanded folders pointing at the same items.
 */
async function scanFolder(
  root: FileSystemDirectoryHandle,
  previous?: LibraryTree,
  options: { isHidden?: (name: string) => boolean } = {},
): Promise<ScanResult> {
  const isHidden = options.isHidden ?? isHiddenEntry;
  const rootId = previous?.rootId ?? 'root';
  const nodes: Record<string, LibraryNode> = {
    [rootId]: { id: rootId, kind: 'folder', name: '', parentId: null },
  };
  const previousIndex = new Map<string, string>();
  if (previous) {
    for (const node of Object.values(previous.nodes)) {
      if (node.parentId === null) continue;
      previousIndex.set(
        `${node.kind}:${pathOf(previous, node.id).map(nameKey).join('/')}`,
        node.id,
      );
    }
  }
  let unreadable = 0;
  const walk = async (
    directory: FileSystemDirectoryHandle,
    parentId: string,
    segments: string[],
  ) => {
    const entries: [string, FileSystemHandle][] = [];
    try {
      for await (const entry of directory.entries()) entries.push(entry);
    } catch {
      unreadable += 1; // skip this folder, keep the rest of the scan
      return;
    }
    const taken = new Set<string>();
    for (const [name, handle] of entries) {
      if (isHidden(name)) continue;
      // A case-twin (possible on Linux) cannot be represented; keep the
      // first, leave the other untouched on disk.
      if (taken.has(nameKey(name))) continue;
      taken.add(nameKey(name));
      const kind = handle.kind === 'directory' ? 'folder' : 'file';
      const childSegments = [...segments, name];
      const id =
        previousIndex.get(`${kind}:${childSegments.map(nameKey).join('/')}`) ??
        newNodeId();
      nodes[id] = { id, kind, name, parentId };
      if (kind === 'folder') {
        await walk(handle as FileSystemDirectoryHandle, id, childSegments);
      }
    }
  };
  await walk(root, rootId, []);
  return { tree: treeFromNodes(rootId, nodes), unreadable };
}

/** Is a stored folder handle still usable without asking? */
async function folderPermission(
  handle: FileSystemDirectoryHandle,
  request: boolean,
  access: FolderAccess = 'readwrite',
): Promise<PermissionState> {
  const descriptor = { mode: access };
  if (request && typeof handle.requestPermission === 'function') {
    return handle.requestPermission(descriptor);
  }
  if (typeof handle.queryPermission === 'function') {
    return handle.queryPermission(descriptor);
  }
  // No permission API at all (a test double): treat as granted.
  return 'granted';
}

function canLinkFolders(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Open the browser's folder picker. Call it DIRECTLY inside the click
 * handler, before any `await`: the picker needs the click's user activation,
 * and a confirm dialog or a storage read first spends it.
 *
 * `id` lets the browser remember the last folder per purpose; `access:
 * 'read'` asks only for read permission (a video library never writes).
 * Resolves to `null` when the user cancels.
 */
async function pickFolder(
  options: { access?: FolderAccess; id?: string } = {},
): Promise<FileSystemDirectoryHandle | null> {
  const picker = typeof window === 'undefined' ? undefined : window.showDirectoryPicker;
  if (picker === undefined) throw new LibraryError('This browser cannot link folders.');
  try {
    return await picker.call(window, { mode: options.access ?? 'readwrite', id: options.id });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

export {
  canLinkFolders,
  ConflictError,
  FolderBackend,
  folderPermission,
  MemoryBackend,
  pickFolder,
  scanFolder,
};
export type { BackendKind, FolderAccess, LibraryBackend, ScanResult, WriteData, WriteOptions };
