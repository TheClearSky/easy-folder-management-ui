/**
 * 0.0.4: UNLINK with a choice (KEEP streams into a blob store, REMOVE empties
 * the library), the blob store itself, and folder access modes (persisted,
 * switchable, refusals handled). The blob store here is the in-memory one;
 * the OPFS store is verified in real Chrome (verification/, not shipped).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsa } from 'memfs/lib/fsa';
import { createMemoryBlobStore } from '../core/blobStore';
import type { BlobStore } from '../core/blobStore';
import { FileLibrary } from '../core/fileLibrary';
import type { UnlinkPlan, UnlinkProgress } from '../core/fileLibrary';
import { createMemoryStore } from '../core/keyValueStore';
import type { KeyValueStore } from '../core/keyValueStore';
import { findByPath } from '../core/libraryTree';
import { extensionPolicy } from '../core/policy';
import { defineTabKinds, tabId } from '../core/tabKinds';
import { Workspace } from '../core/workspace';
import type { ConfirmRequest, UnlinkChoice } from '../core/workspace';

type Dir = FileSystemDirectoryHandle;

const videoPolicy = extensionPolicy({ openable: ['.mp4', '.mkv'], content: 'binary' });
const textPolicy = extensionPolicy({ openable: ['.json'], content: 'text', defaultExtension: '.json' });

async function makeFolder(files: Record<string, string | Uint8Array>): Promise<Dir> {
  const { dir } = fsa({ mode: 'readwrite' });
  const root = dir as unknown as Dir;
  for (const [path, data] of Object.entries(files)) {
    const segments = path.split('/');
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    if (segments[segments.length - 1] === '') continue; // an empty folder
    const handle = await current.getFileHandle(segments[segments.length - 1], { create: true });
    const writable = await handle.createWritable();
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  }
  const proto = Object.getPrototypeOf(root) as { move?: unknown };
  if ('move' in proto) delete proto.move;
  return root;
}

/** `size` bytes of a recognisable pattern. */
function pattern(size: number, seed = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

async function bytesOf(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

async function videoLibrary(
  files: Record<string, string | Uint8Array>,
  options: { store?: KeyValueStore; blobStore?: BlobStore; access?: 'read' | 'readwrite' } = {},
) {
  const store = options.store ?? createMemoryStore();
  const blobStore = options.blobStore ?? createMemoryBlobStore();
  const library = new FileLibrary({ store, policy: videoPolicy, blobStore, access: options.access });
  await library.init();
  const root = await makeFolder(files);
  await library.link(root);
  return { library, store, blobStore, root };
}

/** A memory blob store that calls `onChunk` when the first bytes of a write
 *  land — so a test can cancel in the MIDDLE of a copy. */
function interceptingStore(onChunk: () => void): BlobStore {
  const inner = createMemoryBlobStore();
  let fired = false;
  return {
    ...inner,
    put: (key, data, options = {}) =>
      inner.put(key, data, {
        ...options,
        onProgress: (written) => {
          options.onProgress?.(written);
          if (!fired && written > 0) {
            fired = true;
            onChunk();
          }
        },
      }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('memory blob store', () => {
  it('stores streamed bytes, reports progress, and resumes at an offset', async () => {
    const store = createMemoryBlobStore();
    const seen: number[] = [];
    await store.put('a', new Blob([pattern(10)]), { onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(10);
    expect(await bytesOf((await store.get('a'))!)).toEqual(pattern(10));
    await store.put('a', new Uint8Array([1, 2]), { at: 4 });
    expect(await bytesOf((await store.get('a'))!)).toEqual(new Uint8Array([...pattern(4), 1, 2]));
  });

  it('an aborted write leaves the previous contents (or no entry)', async () => {
    const store = createMemoryBlobStore();
    await store.put('a', 'old');
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
        controller.abort();
      },
    });
    await expect(store.put('a', stream, { signal: controller.signal })).rejects.toThrow();
    expect(await (await store.get('a'))!.text()).toBe('old');
    await expect(store.put('b', 'x', { signal: controller.signal })).rejects.toThrow();
    expect(await store.keys()).toEqual(['a']);
  });
});

describe('UNLINK — plan', () => {
  it('counts, sizes what KEEP copies, and says whether it fits', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 100, quota: 1100 }) } });
    const { library } = await videoLibrary({
      'show/ep01.mkv': pattern(600),
      'show/ep01.srt': 'subs',
      'empty/': '',
      'film.mp4': pattern(300),
    });
    const plan = await library.planUnlink();
    expect(plan).toMatchObject({
      mode: 'folder',
      folders: 2,
      openable: 2,
      otherFiles: 1,
      keep: { folders: 2, files: 2, bytes: 900, leftOnDisk: 1, unreadable: 0 },
      storage: { usage: 100, quota: 1100, available: 1000 },
      fits: true,
    });
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 500, quota: 1100 }) } });
    expect((await library.planUnlink()).fits).toBe(false);
  });

  it('without an estimate, fits is unknown', async () => {
    const { library } = await videoLibrary({ 'film.mp4': pattern(3) });
    const plan = await library.planUnlink();
    expect(plan.storage).toBeNull();
    expect(plan.fits).toBeNull();
  });
});

describe('UNLINK — KEEP', () => {
  it('keeps every folder on disk (empty ones too) and the openable files, byte for byte', async () => {
    const big = pattern(300_000, 7);
    const { library, store, blobStore } = await videoLibrary({
      'show/ep01.mkv': big,
      'show/notes.txt': 'n',
      'empty/': '',
    });
    const progress: UnlinkProgress[] = [];
    const result = await library.unlink({ keep: true, onProgress: (p) => progress.push(p) });
    expect(result).toEqual({ kept: 1, skipped: 0, bytes: big.byteLength });
    expect(findByPath(library.tree, ['empty'])).toBeDefined();
    expect(findByPath(library.tree, ['show', 'notes.txt'])).toBeUndefined();
    const id = findByPath(library.tree, ['show', 'ep01.mkv'])!.id;
    const file = await library.getFile(id);
    expect(file.name).toBe('ep01.mkv');
    expect(file.type).toBe('video/x-matroska');
    expect(await bytesOf(file)).toEqual(big);
    // Progress: first and last always, monotonic, ends complete.
    expect(progress[0]).toMatchObject({ bytesCopied: 0, bytesTotal: big.byteLength, filesTotal: 1 });
    expect(progress.at(-1)).toMatchObject({ bytesCopied: big.byteLength, filesCopied: 1, currentFile: null });
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i].bytesCopied).toBeGreaterThanOrEqual(progress[i - 1].bytesCopied);
    }
    expect(library.getSnapshot().unlinkProgress).toBeNull();
    expect(library.getSnapshot().folderAccess).toBeNull();

    // A reload finds the same library, contents from the blob store.
    const reloaded = new FileLibrary({ store, policy: videoPolicy, blobStore });
    await reloaded.init();
    expect(reloaded.mode.kind).toBe('memory');
    expect(await bytesOf(await reloaded.getFile(id))).toEqual(big);
  });

  it('a cancelled copy leaves the folder linked, unchanged, and nothing copied', async () => {
    const controller = new AbortController();
    const blobStore = interceptingStore(() => controller.abort());
    const { library, store, root } = await videoLibrary(
      { 'a.mp4': pattern(200_000, 1), 'b.mp4': pattern(200_000, 2) },
      { blobStore },
    );
    const treeBefore = library.tree;
    const unlinking = library.unlink({ keep: true, signal: controller.signal });
    await expect(unlinking).rejects.toMatchObject({ name: 'AbortError' });
    expect(library.mode).toEqual({ kind: 'folder', folderName: root.name });
    expect(library.tree).toBe(treeBefore);
    expect(await blobStore.keys()).toEqual([]);
    expect(await store.get('tree')).toBeUndefined();
    expect(await store.get('folderHandle')).toBe(root);
    expect(library.getSnapshot().error).toBeNull(); // a cancel is not an error…
    expect(library.getSnapshot().notice).toMatch(/cancelled/); // …but it is said
    expect(library.getSnapshot().unlinkProgress).toBeNull();
  });

  it('cancelUnlink() stops the copy in progress', async () => {
    let cancel = () => {};
    const blobStore = interceptingStore(() => cancel());
    const { library } = await videoLibrary({ 'a.mp4': pattern(300_000), 'b.mp4': pattern(10) }, { blobStore });
    cancel = () => library.cancelUnlink();
    const unlinking = library.unlink({ keep: true });
    await expect(unlinking).rejects.toMatchObject({ name: 'AbortError' });
    expect(library.mode.kind).toBe('folder');
    expect(await blobStore.keys()).toEqual([]);
  });

  it('a failing copy (out of space) cleans up and stays linked', async () => {
    const inner = createMemoryBlobStore();
    let puts = 0;
    const failing: BlobStore = {
      ...inner,
      put: async (key, data, options) => {
        puts += 1;
        if (puts === 2) throw new DOMException('quota', 'QuotaExceededError');
        return inner.put(key, data, options);
      },
    };
    const { library, root } = await videoLibrary({ 'a.mp4': pattern(10), 'b.mp4': pattern(10) }, { blobStore: failing });
    await expect(library.unlink({ keep: true })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(library.mode).toEqual({ kind: 'folder', folderName: root.name });
    expect(await inner.keys()).toEqual([]);
    expect(library.getSnapshot().error).toMatch(/out of storage/);
  });

  it('refuses up front when the browser says it will not fit', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 0, quota: 50 }) } });
    const { library, blobStore } = await videoLibrary({ 'a.mp4': pattern(100) });
    await expect(library.unlink({ keep: true })).rejects.toThrow(/Not enough browser storage/);
    expect(library.mode.kind).toBe('folder');
    expect(await blobStore.keys()).toEqual([]);
  });

  it('asks for persistent storage before copying', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persist, persisted: async () => false } });
    const { library } = await videoLibrary({ 'a.mp4': pattern(10) });
    await library.unlink({ keep: true });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('a file that vanished from disk is skipped and reported, not fatal', async () => {
    const { library, root } = await videoLibrary({ 'a.mp4': pattern(10), 'gone.mp4': pattern(10) });
    await root.removeEntry('gone.mp4');
    const result = await library.unlink({ keep: true });
    expect(result).toMatchObject({ kept: 1, skipped: 1 });
    expect(findByPath(library.tree, ['gone.mp4'])).toBeUndefined();
    expect(library.getSnapshot().notice).toMatch(/1 file\(s\) could not be read/);
  });

  it("a text policy keeps Nodestra's format: strings under file:<id>, no blob store", async () => {
    const store = createMemoryStore();
    const library = new FileLibrary({ store, policy: textPolicy });
    await library.init();
    expect(library.blobStore).toBeNull();
    await library.link(await makeFolder({ 'drums/kick.json': '{"k":1}' }));
    await library.unlink({ keep: true });
    const kick = findByPath(library.tree, ['drums', 'kick.json'])!;
    expect(await store.get(`file:${kick.id}`)).toBe('{"k":1}');
  });
});

describe('blob store selection', () => {
  const opfsNavigator = { storage: { getDirectory: async () => ({}) } };

  it("'auto' uses OPFS only for a binary policy over a persistent store", () => {
    vi.stubGlobal('navigator', opfsNavigator);
    const persistent: KeyValueStore = { ...createMemoryStore(), name: 'videos.library' };
    const binary = new FileLibrary({ store: persistent, policy: videoPolicy });
    expect(binary.blobStore).toMatchObject({ kind: 'opfs', name: 'videos.library.blobs' });
    expect(new FileLibrary({ store: persistent, policy: textPolicy }).blobStore).toBeNull();
    expect(new FileLibrary({ store: createMemoryStore(), policy: videoPolicy }).blobStore).toBeNull();
    expect(new FileLibrary({ store: persistent, policy: videoPolicy, blobStore: null }).blobStore).toBeNull();
  });

  it('falls back to the key-value store when OPFS is refused at first use', async () => {
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => Promise.reject(new DOMException('no', 'SecurityError')) },
    });
    const library = new FileLibrary({ store: { ...createMemoryStore(), name: 'x' }, policy: videoPolicy });
    expect(library.blobStore?.kind).toBe('opfs');
    await library.init();
    expect(library.blobStore).toBeNull();
    const id = await library.createFile(library.tree.rootId, 'a.mp4', new Uint8Array([1, 2]));
    expect(await bytesOf(await library.getFile(id))).toEqual(new Uint8Array([1, 2]));
  });
});

describe('in-browser binary library', () => {
  async function memoryVideos() {
    const store = createMemoryStore();
    const blobStore = createMemoryBlobStore();
    const library = new FileLibrary({ store, policy: videoPolicy, blobStore });
    await library.init();
    return { library, store, blobStore };
  }

  it('rename and move keep the bytes; delete frees them; undo does not pretend', async () => {
    const { library, blobStore } = await memoryVideos();
    const folder = await library.createFolder(library.tree.rootId, 'Show');
    const id = await library.createFile(library.tree.rootId, 'ep.mkv', pattern(1000));
    await library.rename(id, 'ep01.mkv');
    await library.move([id], folder);
    expect(await bytesOf(await library.getFile(id))).toEqual(pattern(1000));
    expect(await blobStore.keys()).toEqual([id]);
    await library.remove([folder]);
    expect(await blobStore.keys()).toEqual([]);
    // Nothing of the video was kept, so Undo is not offered at all (it
    // would bring back an empty folder and call that an undo).
    expect(library.getSnapshot().undoableDelete).toBeNull();
    expect(await library.undoDelete()).toEqual([]);
    expect(findByPath(library.tree, ['Show'])).toBeUndefined();
  });

  it('a delete of folders alone can still be undone', async () => {
    const { library } = await memoryVideos();
    const folder = await library.createFolder(library.tree.rootId, 'Empty');
    await library.remove([folder]);
    expect(library.getSnapshot().undoableDelete).toBe('"Empty"');
    await library.undoDelete();
    expect(findByPath(library.tree, ['Empty'])).toBeDefined();
  });

  it('text written into a binary library stays a string in the key-value store', async () => {
    const { library, store, blobStore } = await memoryVideos();
    const id = await library.createFile(library.tree.rootId, 'ep.srt', '1');
    expect(await store.get(`file:${id}`)).toBe('1');
    expect(await blobStore.keys()).toEqual([]);
  });

  it('sweeps blob-store entries no file refers to at start-up (after a grace period)', async () => {
    const { library, store, blobStore } = await memoryVideos();
    const kept = await library.createFile(library.tree.rootId, 'a.mp4', pattern(5));
    await blobStore.put('orphan-from-a-crash', pattern(5));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const reloaded = new FileLibrary({ store, policy: videoPolicy, blobStore });
    await reloaded.init();
    expect(await blobStore.keys()).toEqual([kept]);
  });

  it('a fresh orphan (another tab still writing it) survives the sweep', async () => {
    const { store, blobStore } = await memoryVideos();
    await blobStore.put('being-written', pattern(5));
    const reloaded = new FileLibrary({ store, policy: videoPolicy, blobStore });
    await reloaded.init();
    expect(await blobStore.keys()).toEqual(['being-written']);
  });
});

describe('folder access modes', () => {
  /** Stub a permission API on a memfs handle (memfs has none). */
  function permissions(handle: Dir, state: { read: PermissionState; readwrite: PermissionState; requests: string[] }) {
    const target = handle as unknown as {
      queryPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
      requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    };
    target.queryPermission = async ({ mode }) => state[mode];
    target.requestPermission = async ({ mode }) => {
      state.requests.push(mode);
      return state[mode];
    };
    return state;
  }

  it('link with an access, persisted with the handle; boot asks for THAT access', async () => {
    vi.stubGlobal('window', { showDirectoryPicker: () => {} });
    const store = createMemoryStore();
    const library = new FileLibrary({ store, policy: videoPolicy });
    await library.init();
    const root = await makeFolder({ 'a.mp4': 'v' });
    await library.link(root, { access: 'read' });
    expect(library.getSnapshot().folderAccess).toBe('read');
    expect(library.writable).toBe(false);
    expect(await store.get('folderAccess')).toBe('read');

    const reloaded = new FileLibrary({ store, policy: videoPolicy });
    await reloaded.init();
    expect(reloaded.mode.kind).toBe('folder');
    expect(reloaded.getSnapshot().folderAccess).toBe('read');
    await expect(reloaded.createFolder(reloaded.tree.rootId, 'x')).rejects.toThrow(
      'This folder is open read-only. Switch it to Read & write to change it.',
    );

    expect(await reloaded.setAccess('readwrite')).toBe(true);
    expect(reloaded.getSnapshot().folderAccess).toBe('readwrite');
    const again = new FileLibrary({ store, policy: videoPolicy });
    await again.init();
    expect(again.getSnapshot().folderAccess).toBe('readwrite');
    expect(again.writable).toBe(true);
  });

  it('a refused upgrade stays read-only and says so', async () => {
    const { library, root } = await videoLibrary({ 'a.mp4': 'v' }, { access: 'read' });
    const state = permissions(root, { read: 'granted', readwrite: 'denied', requests: [] });
    expect(await library.setAccess('readwrite')).toBe(false);
    expect(state.requests).toEqual(['readwrite']);
    expect(library.getSnapshot().folderAccess).toBe('read');
    expect(library.getSnapshot().notice).toMatch(/stays read-only/);
    expect(await library.requestWriteAccess()).toBe(false); // the old name, same rule
  });

  it('a downgrade waits for the write already queued, then refuses writes', async () => {
    const { library, root } = await videoLibrary({ 'a.mp4': 'v' });
    const id = findByPath(library.tree, ['a.mp4'])!.id;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode('saved'));
        controller.close();
      },
    });
    const write = library.write(id, slow, { force: true });
    const downgrade = library.setAccess('read');
    await Promise.resolve();
    expect(library.getSnapshot().folderAccess).toBe('readwrite'); // still writing
    release();
    await write;
    expect(await downgrade).toBe(true);
    expect(await (await (await root.getFileHandle('a.mp4')).getFile()).text()).toBe('saved');
    await expect(library.write(id, 'later', { force: true })).rejects.toThrow('read-only');
  });

  it('after a reload without write permission: reconnect read-write, or continue read-only', async () => {
    vi.stubGlobal('window', { showDirectoryPicker: () => {} });
    const store = createMemoryStore();
    const first = new FileLibrary({ store, policy: videoPolicy });
    await first.init();
    const root = await makeFolder({ 'a.mp4': 'v' });
    await first.link(root, { access: 'readwrite' });
    const state = permissions(root, { read: 'prompt', readwrite: 'prompt', requests: [] });

    const library = new FileLibrary({ store, policy: videoPolicy });
    await library.init();
    expect(library.mode).toEqual({ kind: 'reconnect', folderName: root.name });
    expect(library.getSnapshot().folderAccess).toBe('readwrite');

    state.readwrite = 'denied';
    await expect(library.reconnect()).rejects.toThrow(/continue read-only/);
    expect(library.mode.kind).toBe('reconnect');

    state.read = 'granted';
    await library.reconnect({ access: 'read' });
    expect(state.requests).toEqual(['readwrite', 'read']);
    expect(library.mode.kind).toBe('folder');
    expect(library.getSnapshot().folderAccess).toBe('read');
    expect(await store.get('folderAccess')).toBe('read');
  });

  it('the in-browser library is always writable; unlink forgets the access', async () => {
    const { library, store } = await videoLibrary({ 'a.mp4': 'v' }, { access: 'read' });
    await library.unlink({ keep: false });
    expect(library.getSnapshot().folderAccess).toBeNull();
    expect(await store.get('folderAccess')).toBeUndefined();
    expect(await library.setAccess('readwrite')).toBe(true);
    expect(await library.setAccess('read')).toBe(false);
    expect(library.writable).toBe(true);
  });
});

describe('Workspace — unlink choice and access', () => {
  const kinds = defineTabKinds({ file: { persist: 'file' }, welcome: { persist: 'key' } });

  async function setup(
    choice: UnlinkChoice,
    files: Record<string, string | Uint8Array>,
    blobStore: BlobStore = createMemoryBlobStore(),
  ) {
    const library = new FileLibrary({ store: createMemoryStore(), policy: videoPolicy, blobStore });
    const plans: UnlinkPlan[] = [];
    const shown: (string | null)[] = [];
    const ws = new Workspace<File>({
      library,
      kinds,
      documents: {
        load: async (file) => ({ ok: true, content: await file.getFile() }),
        install: (file) => shown.push(file.name),
        closeEditor: () => shown.push(null),
      },
      chooseUnlink: async (plan) => {
        plans.push(plan);
        return choice;
      },
    });
    await ws.boot();
    const root = await makeFolder(files);
    expect(await ws.link(root)).toBe(true);
    const id = (path: string[]) => findByPath(library.tree, path)!.id;
    return { ws, library, plans, shown, root, id };
  }

  it('cancel changes nothing', async () => {
    const { ws, library, plans } = await setup('cancel', { 'a.mp4': pattern(4) });
    expect(await ws.unlink()).toBe(false);
    expect(plans[0]).toMatchObject({ mode: 'folder', keep: { files: 1, bytes: 4 } });
    expect(library.mode.kind).toBe('folder');
  });

  it('KEEP: the open video stays open, playable from the browser copy', async () => {
    const { ws, library, id } = await setup('keep', { 'show/a.mp4': pattern(64) });
    const a = id(['show', 'a.mp4']);
    await ws.openFile(a);
    const progress: UnlinkProgress[] = [];
    expect(await ws.unlink({ onProgress: (p) => progress.push(p) })).toBe(true);
    expect(library.mode.kind).toBe('memory');
    expect(ws.getSnapshot().activeFileId).toBe(a);
    expect(ws.getSnapshot().tabs.order).toEqual([tabId('file', a)]);
    expect(await bytesOf(await library.getFile(a))).toEqual(pattern(64));
    expect(progress.at(-1)?.bytesCopied).toBe(64);
  });

  it('REMOVE: an empty library, and the file tabs close', async () => {
    const { ws, library, id, shown } = await setup('remove', { 'show/a.mp4': pattern(8) });
    const a = id(['show', 'a.mp4']);
    await ws.openFile(a);
    expect(await ws.unlink()).toBe(true);
    expect(Object.keys(library.tree.nodes)).toEqual([library.tree.rootId]);
    expect(ws.getSnapshot().tabs.order).toEqual([]);
    expect(ws.getSnapshot().activeFileId).toBeNull();
    expect(shown.at(-1)).toBeNull();
  });

  it('a cancelled KEEP resolves false and keeps the folder', async () => {
    let cancel = () => {};
    const { ws, library } = await setup('keep', { 'a.mp4': pattern(200_000) }, interceptingStore(() => cancel()));
    cancel = () => ws.cancelUnlink();
    expect(await ws.unlink()).toBe(false);
    expect(library.mode.kind).toBe('folder');
  });

  it("a downgrade saves the open file's pending edit before refusing writes", async () => {
    const library = new FileLibrary({ store: createMemoryStore(), policy: textPolicy });
    let text = '';
    const ws = new Workspace<string>({
      library,
      kinds,
      save: { enabled: true, delaySeconds: 60 }, // armed, not yet fired
      documents: {
        load: async (file) => ({ ok: true, content: await file.readText() }),
        install: (content) => (text = content),
        closeEditor: () => (text = ''),
        serialize: () => text,
      },
    });
    await ws.boot();
    const root = await makeFolder({ 'a.json': 'old' });
    await ws.link(root);
    await ws.openFile(findByPath(library.tree, ['a.json'])!.id);
    await new Promise((resolve) => setTimeout(resolve, 350)); // the baseline settles
    text = 'edited';
    ws.contentChanged();
    expect(await ws.setFolderAccess('read')).toBe(true);
    expect(await (await (await root.getFileHandle('a.json')).getFile()).text()).toBe('edited');
    expect(ws.getSnapshot().saveStatus).toBe('unavailable');
  });

  it('a delete confirm says how many files cannot be undone', async () => {
    const requests: ConfirmRequest[] = [];
    const library = new FileLibrary({ store: createMemoryStore(), policy: videoPolicy, blobStore: createMemoryBlobStore() });
    const ws = new Workspace<File>({
      library,
      kinds,
      documents: { load: async (file) => ({ ok: true, content: await file.getFile() }), install: () => {}, closeEditor: () => {} },
      confirm: async (request) => {
        requests.push(request);
        return true;
      },
    });
    await ws.boot();
    const folder = await library.createFolder(library.tree.rootId, 'Show');
    await library.createFile(folder, 'ep01.mkv', pattern(3));
    await library.createFile(folder, 'ep01.srt', 'subs');
    expect(await ws.remove([folder])).toBe(true);
    expect(requests[0]).toMatchObject({ kind: 'delete', onDisk: false, openable: 1, otherFiles: 1, permanent: 2 });
  });

  it('setFolderAccess switches both ways and the snapshot follows', async () => {
    const { ws } = await setup('cancel', { 'a.mp4': pattern(1) });
    expect(ws.getSnapshot().library.folderAccess).toBe('readwrite');
    expect(await ws.setFolderAccess('read')).toBe(true);
    expect(ws.getSnapshot().library.folderAccess).toBe('read');
    expect(ws.getSnapshot().readOnly).toBe(true);
    expect(await ws.setFolderAccess('readwrite')).toBe(true);
    expect(ws.getSnapshot().readOnly).toBe(false);
  });
});
