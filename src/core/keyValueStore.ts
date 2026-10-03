/**
 * The smallest storage the library needs: async get / set / delete by string
 * key, holding structured-cloneable values (strings, plain objects, and
 * FileSystemDirectoryHandle — which is why this is IndexedDB and not
 * localStorage: a folder handle survives a reload ONLY in IndexedDB).
 *
 * Why not localStorage for the files themselves: a project file is 0.6-0.86
 * MB (it embeds the node-type library), so a ~5 MB localStorage quota holds
 * five to seven of them, and the old autosave swallowed the quota error
 * silently. IndexedDB's quota is a share of free disk.
 *
 * Raw IndexedDB rather than a wrapper package: this is the whole surface.
 */

interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const STORE_NAME = 'kv';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** `databaseName` is the app's own (Nodestra: `react-blender-nodes-sound.library`) —
 * the library never picks one, so two apps on one origin never share a store. */
function createIndexedDbStore(databaseName: string): KeyValueStore {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = undefined; // allow a retry after a transient failure
        reject(request.error ?? new Error('Could not open the library database'));
      };
      request.onblocked = () =>
        reject(new Error('The library database is blocked by another tab'));
    });
    return opening;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const database = await open();
    const transaction = database.transaction(STORE_NAME, mode);
    // Listen BEFORE issuing the request, so the completion event can never
    // fire unobserved. Resolve only once a write is DURABLE, not merely
    // queued — a caller that then deletes the source of a copy relies on it.
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Library write was aborted'));
    });
    const result = await requestToPromise(work(transaction.objectStore(STORE_NAME)));
    await committed;
    return result;
  };
  return {
    get: <T,>(key: string) => run('readonly', (store) => store.get(key)) as Promise<T | undefined>,
    set: async (key, value) => {
      await run('readwrite', (store) => store.put(value, key));
    },
    delete: async (key) => {
      await run('readwrite', (store) => store.delete(key));
    },
    keys: async () =>
      (await run('readonly', (store) => store.getAllKeys())).map(String),
  };
}

/** Same contract, held in a Map — for tests, and as the fallback when a
 *  browser refuses IndexedDB (some private modes). */
function createMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T,>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    keys: async () => [...map.keys()],
  };
}

export { createIndexedDbStore, createMemoryStore };
export type { KeyValueStore };
