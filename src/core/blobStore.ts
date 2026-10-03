/**
 * Where the in-browser library keeps BINARY contents — a 4 GB video copied out
 * of a folder that is being unlinked must never pass through memory.
 *
 *  - `createOpfsBlobStore(name)`: the Origin Private File System
 *    (`navigator.storage.getDirectory()`), one subdirectory owned by the
 *    library, one file per library file (named by its id). Writes are piped
 *    chunk by chunk into a `FileSystemWritableFileStream`, which the browser
 *    commits on close — a failed or cancelled write leaves the previous
 *    contents (or no entry at all). `get` returns the browser's disk-backed
 *    `File`, so `URL.createObjectURL` plays it without reading it.
 *  - `createMemoryBlobStore()`: the same contract in a Map, for tests and for
 *    libraries that live in memory anyway.
 *
 * Text never comes here: the key-value store keeps it as strings (the format
 * Nodestra's stored libraries already hold under `file:<id>`).
 */

import type { WriteData } from './backends';

type BlobWriteOptions = {
  /** Keep the first `at` bytes and write from there (a resumed write). */
  at?: number;
  /** Abort the write; the previous contents stay. */
  signal?: AbortSignal;
  /** Bytes written by THIS call so far, as chunks land. */
  onProgress?(bytesWritten: number): void;
};

interface BlobStore {
  /** Names the store (the OPFS directory) — also its cross-tab lock. */
  readonly name: string;
  /** Where the bytes live: `'opfs'` is on disk, `'memory'` is in this tab. */
  readonly kind: 'opfs' | 'memory';
  /** The contents as a `File` (disk-backed for OPFS), or `undefined`. */
  get(key: string): Promise<File | undefined>;
  /** Replace `key`'s contents. All-or-nothing: a failure or an abort leaves
   *  the previous contents, or no entry when there was none. */
  put(key: string, data: WriteData, options?: BlobWriteOptions): Promise<void>;
  /** Remove `key`; a missing key is not an error. */
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

function isStream(data: WriteData): data is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && data instanceof ReadableStream;
}

/** Any `WriteData` as a byte stream — a Blob/File streams from where it
 *  lives (disk for a linked file), never via one big buffer. */
function toByteStream(data: WriteData): ReadableStream<Uint8Array> {
  if (isStream(data)) return data;
  const blob = data instanceof Blob ? data : new Blob([data]);
  return blob.stream() as ReadableStream<Uint8Array>;
}

/** A pass-through that reports the running byte count. */
function counting(onProgress?: (bytes: number) => void): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      onProgress?.(total);
      controller.enqueue(chunk);
    },
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was cancelled.', 'AbortError');
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

// ─────────────────────────────── memory ────────────────────────────────

/** The BlobStore contract held in a Map (tests; libraries that live in
 *  memory anyway). Streams are still consumed chunk by chunk, so progress
 *  and cancellation behave like the OPFS store. */
function createMemoryBlobStore(name = 'memory'): BlobStore {
  const map = new Map<string, Blob>();
  return {
    name,
    kind: 'memory',
    get: async (key) => {
      const blob = map.get(key);
      return blob === undefined ? undefined : new File([blob], key, { type: blob.type });
    },
    put: async (key, data, options = {}) => {
      const { signal } = options;
      if (signal?.aborted) throw abortError(signal);
      const parts: BlobPart[] = [];
      if (options.at !== undefined) parts.push((map.get(key) ?? new Blob([])).slice(0, options.at));
      const reader = toByteStream(data).pipeThrough(counting(options.onProgress)).getReader();
      const onAbort = () => void reader.cancel(abortError(signal!)).catch(() => {});
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        for (;;) {
          if (signal?.aborted) throw abortError(signal);
          const { done, value } = await reader.read();
          if (signal?.aborted) throw abortError(signal);
          if (done) break;
          parts.push(value as BlobPart);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      // Committed only now: a failure above left the previous entry alone.
      map.set(key, new Blob(parts, { type: data instanceof Blob ? data.type : '' }));
    },
    delete: async (key) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
  };
}

// ──────────────────────────────── OPFS ─────────────────────────────────

/** Does this browser have the Origin Private File System? */
function canUseOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { storage?: StorageManager }).storage?.getDirectory === 'function'
  );
}

/**
 * A BlobStore in the Origin Private File System, under the subdirectory
 * `directoryName` (the app's own — two apps on one origin must not share
 * one). Contents are never held in memory: writes pipe through a
 * `FileSystemWritableFileStream`, reads return disk-backed Files.
 */
function createOpfsBlobStore(directoryName: string): BlobStore {
  let opening: Promise<FileSystemDirectoryHandle> | undefined;
  const directory = (): Promise<FileSystemDirectoryHandle> => {
    opening ??= navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(directoryName, { create: true }));
    opening.catch(() => {
      opening = undefined; // allow a retry after a transient failure
    });
    return opening;
  };
  return {
    name: directoryName,
    kind: 'opfs',
    async get(key) {
      const dir = await directory();
      try {
        return await (await dir.getFileHandle(key)).getFile();
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async put(key, data, options = {}) {
      const { signal } = options;
      if (signal?.aborted) throw abortError(signal);
      const dir = await directory();
      let existed = true;
      try {
        await dir.getFileHandle(key);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        existed = false;
      }
      const handle = await dir.getFileHandle(key, { create: true });
      try {
        const keep = options.at !== undefined;
        const writable = await handle.createWritable({ keepExistingData: keep });
        try {
          if (keep) {
            await writable.truncate(options.at!);
            await writable.seek(options.at!);
          }
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
        // pipeTo closes (commits) on success and ABORTS the writable on a
        // failure or an abort signal — the browser then drops its swap file
        // and the previous contents stay.
        await toByteStream(data)
          .pipeThrough(counting(options.onProgress))
          .pipeTo(writable as unknown as WritableStream<Uint8Array>, { signal });
      } catch (error) {
        // A failed FIRST write must not leave an empty entry behind.
        if (!existed) await dir.removeEntry(key).catch(() => {});
        throw error;
      }
    },
    async delete(key) {
      const dir = await directory();
      try {
        await dir.removeEntry(key);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async keys() {
      const dir = await directory();
      const names: string[] = [];
      for await (const name of dir.keys()) names.push(name);
      return names;
    },
  };
}

// ─────────────────────────────── storage ───────────────────────────────

type StorageInfo = {
  /** Bytes this site already uses (all of its storage). */
  usage: number;
  /** Bytes this site may use. */
  quota: number;
  /** `quota - usage`, never negative. */
  available: number;
};

/** `navigator.storage.estimate()`, or `null` when the browser does not say. */
async function estimateStorage(): Promise<StorageInfo | null> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage || typeof storage.estimate !== 'function') return null;
    const { usage, quota } = await storage.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number') return null;
    return { usage, quota, available: Math.max(0, quota - usage) };
  } catch {
    return null;
  }
}

/** Ask the browser not to evict this site's storage under pressure
 *  (`navigator.storage.persist()`). Chrome decides silently; Firefox may
 *  ask the user. Resolves whether storage is (now) persistent. */
async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}

/**
 * Run `work` under the store's cross-tab lock (Web Locks). Copies and writes
 * hold it SHARED; the start-up sweep of orphaned entries takes it EXCLUSIVE
 * and only if free, so it never deletes what another tab is still writing.
 * Without Web Locks (Node), `work` just runs. Resolves `undefined` when
 * `ifAvailable` found the lock taken.
 */
async function withBlobLock<T>(
  store: BlobStore,
  mode: 'shared' | 'exclusive',
  work: () => Promise<T>,
  ifAvailable = false,
): Promise<T | undefined> {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return work();
  return locks.request(`efm-blobs:${store.name}`, { mode, ifAvailable }, async (lock) =>
    lock === null ? undefined : work(),
  );
}

const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.vtt': 'text/vtt',
  '.srt': 'application/x-subrip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** A media type from a file name. Store entries are named by id, so the
 *  browser cannot infer one; players and `<video>` like having it. */
function mediaTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : (MEDIA_TYPES[name.slice(dot).toLowerCase()] ?? '');
}

export {
  canUseOpfs,
  createMemoryBlobStore,
  createOpfsBlobStore,
  estimateStorage,
  mediaTypeOf,
  requestPersistentStorage,
  withBlobLock,
};
export type { BlobStore, BlobWriteOptions, StorageInfo };
