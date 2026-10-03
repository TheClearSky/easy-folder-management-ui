/**
 * The library's behaviour, through its public API, on both backends. The
 * folder is memfs's in-memory File System Access implementation with `move`
 * stripped, so it behaves like stable Chrome (see libraryBackends.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { fsa } from 'memfs/lib/fsa';
import { FileLibrary } from '../core/fileLibrary';
import { createMemoryStore } from '../core/keyValueStore';
import { findByPath, pathOf } from '../core/libraryTree';
import { extensionPolicy } from '../core/policy';

/** Nodestra's policy: `.json` graphs, as text. */
const policy = extensionPolicy({ openable: ['.json'], content: 'text', defaultExtension: '.json' });
/** watch-together's policy: videos, never read into memory. */
const videoPolicy = extensionPolicy({ openable: ['.mp4', '.mkv', '.webm'], content: 'binary' });

type Dir = FileSystemDirectoryHandle;

async function makeFolder(files: Record<string, string>): Promise<Dir> {
  const { dir } = fsa({ mode: 'readwrite' });
  const root = dir as unknown as Dir;
  for (const [path, text] of Object.entries(files)) {
    const segments = path.split('/');
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    const handle = await current.getFileHandle(segments[segments.length - 1], {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }
  const proto = Object.getPrototypeOf(root) as { move?: unknown };
  if ('move' in proto) delete proto.move;
  return root;
}

async function readDisk(root: Dir, path: string): Promise<string | undefined> {
  const segments = path.split('/');
  try {
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment);
    }
    const file = await current.getFileHandle(segments[segments.length - 1]);
    return (await file.getFile()).text();
  } catch {
    return undefined;
  }
}

async function freshMemoryLibrary() {
  const store = createMemoryStore();
  const library = new FileLibrary({ store, policy });
  await library.init();
  return { library, store };
}

describe('FileLibrary — memory', () => {
  it('boots empty, creates with unique names, and survives a reload', async () => {
    const { library, store } = await freshMemoryLibrary();
    expect(library.mode.kind).toBe('memory');
    const folder = await library.createFolder(library.tree.rootId, 'New folder');
    const a = await library.createFile(folder, 'Untitled.json', 'A');
    const b = await library.createFile(folder, 'Untitled.json', 'B');
    expect(library.tree.nodes[b].name).toBe('Untitled 2.json');

    const reloaded = new FileLibrary({ store, policy });
    await reloaded.init();
    expect(pathOf(reloaded.tree, a)).toEqual(['New folder', 'Untitled.json']);
    expect(await reloaded.readText(b)).toBe('B');
  });

  it('awaits the mutation guard BEFORE moving a file', async () => {
    const { library } = await freshMemoryLibrary();
    const file = await library.createFile(library.tree.rootId, 'a.json', 'x');
    const folder = await library.createFolder(library.tree.rootId, 'f');
    const order: string[] = [];
    library.beforeMutate = async (ids) => {
      order.push(`guard:${ids.includes(file)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('guard done');
    };
    await library.move([file], folder).then(() => order.push('moved'));
    expect(order).toEqual(['guard:true', 'guard done', 'moved']);
  });

  it('serialises operations: a save issued before a rename lands first', async () => {
    const { library } = await freshMemoryLibrary();
    const file = await library.createFile(library.tree.rootId, 'a.json', 'old');
    const save = library.write(file, 'new');
    const rename = library.rename(file, 'b.json');
    await Promise.all([save, rename]);
    expect(library.tree.nodes[file].name).toBe('b.json');
    expect(await library.readText(file)).toBe('new');
  });

  it('shows a refused operation as an error and leaves the tree unchanged', async () => {
    const { library } = await freshMemoryLibrary();
    const a = await library.createFile(library.tree.rootId, 'a.json', '');
    await library.createFile(library.tree.rootId, 'b.json', '');
    const before = library.tree;
    await expect(library.rename(a, 'B.JSON')).rejects.toThrow(/already exists/);
    expect(library.tree).toBe(before);
    expect(library.getSnapshot().error).toMatch(/already exists/);
    library.dismissError();
    expect(library.getSnapshot().error).toBeNull();
  });

  it('undoes a delete of a folder with its graphs', async () => {
    const { library } = await freshMemoryLibrary();
    const folder = await library.createFolder(library.tree.rootId, 'drums');
    await library.createFile(folder, 'kick.json', 'K');
    await library.remove([folder]);
    expect(findByPath(library.tree, ['drums'])).toBeUndefined();
    expect(library.getSnapshot().undoableDelete).toBe('"drums"');
    await library.undoDelete();
    const kick = findByPath(library.tree, ['drums', 'kick.json']);
    expect(kick).toBeDefined();
    expect(await library.readText(kick!.id)).toBe('K');
    expect(library.getSnapshot().undoableDelete).toBeNull();
  });
});

describe('FileLibrary — linked folder', () => {
  it('LINK discards the in-memory library and loads the folder', async () => {
    const { library } = await freshMemoryLibrary();
    await library.createFile(library.tree.rootId, 'memory-only.json', 'M');
    const root = await makeFolder({ 'disk.json': 'D', 'notes.txt': 'n' });
    await library.link(root);
    expect(library.mode).toEqual({ kind: 'folder', folderName: root.name });
    expect(findByPath(library.tree, ['memory-only.json'])).toBeUndefined();
    expect(findByPath(library.tree, ['disk.json'])).toBeDefined();
    expect(findByPath(library.tree, ['notes.txt'])).toBeDefined();
  });

  it('mirrors create, rename, move and delete to disk', async () => {
    const { library } = await freshMemoryLibrary();
    const root = await makeFolder({});
    await library.link(root);
    const folder = await library.createFolder(library.tree.rootId, 'drums');
    const file = await library.createFile(library.tree.rootId, 'kick.json', 'K');
    expect(await readDisk(root, 'kick.json')).toBe('K');
    await library.rename(file, 'boom.json');
    expect(await readDisk(root, 'boom.json')).toBe('K');
    expect(await readDisk(root, 'kick.json')).toBeUndefined();
    await library.move([file], folder);
    expect(await readDisk(root, 'drums/boom.json')).toBe('K');
    await library.remove([folder]);
    expect(await readDisk(root, 'drums/boom.json')).toBeUndefined();
  });

  it('UNLINK copies folders and .json files into memory, not other files', async () => {
    const { library, store } = await freshMemoryLibrary();
    const root = await makeFolder({
      'drums/kick.json': 'K',
      'drums/kick.wav': 'RIFF',
      'notes.txt': 'n',
      'broken.json': 'not json',
    });
    await library.link(root);
    const kickId = findByPath(library.tree, ['drums', 'kick.json'])!.id;
    expect(library.unlinkSummary()).toEqual({ folders: 1, openable: 2, otherFiles: 2 });
    await library.unlink();
    expect(library.mode.kind).toBe('memory');
    expect(findByPath(library.tree, ['drums', 'kick.wav'])).toBeUndefined();
    expect(findByPath(library.tree, ['notes.txt'])).toBeUndefined();
    // Same id: the open file stays open across an unlink.
    expect(findByPath(library.tree, ['drums', 'kick.json'])!.id).toBe(kickId);
    expect(await library.readText(kickId)).toBe('K');
    const broken = findByPath(library.tree, ['broken.json'])!;
    expect(await library.readText(broken.id)).toBe('not json');

    // And it is the library after a reload, with the folder forgotten.
    const reloaded = new FileLibrary({ store, policy });
    await reloaded.init();
    expect(reloaded.mode.kind).toBe('memory');
    expect(findByPath(reloaded.tree, ['drums', 'kick.json'])).toBeDefined();
  });

  it('keeps ids across a rescan after an outside change', async () => {
    const { library } = await freshMemoryLibrary();
    const root = await makeFolder({ 'a.json': 'A' });
    await library.link(root);
    const a = findByPath(library.tree, ['a.json'])!.id;
    const handle = await root.getFileHandle('new.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write('N');
    await writable.close();
    // Throttled: a focus-driven rescan right after linking does nothing.
    await library.rescan();
    expect(findByPath(library.tree, ['new.json'])).toBeUndefined();
    await library.rescan({ force: true });
    expect(findByPath(library.tree, ['a.json'])!.id).toBe(a);
    expect(findByPath(library.tree, ['new.json'])).toBeDefined();
  });

  it('keeps the SAME tree object when a rescan finds nothing changed', async () => {
    const { library } = await freshMemoryLibrary();
    const root = await makeFolder({ 'a.json': 'A' });
    await library.link(root);
    const before = library.tree;
    await library.rescan({ force: true });
    expect(library.tree).toBe(before);
  });

  it('a pre-change save of the OPEN file does not deadlock the queue', async () => {
    // The mutation guard saves through the queue; it must run OUTSIDE it.
    const { library } = await freshMemoryLibrary();
    const file = await library.createFile(library.tree.rootId, 'a.json', 'old');
    library.beforeMutate = async (ids) => {
      if (ids.includes(file)) await library.write(file, 'saved first');
    };
    const outcome = await Promise.race([
      library.rename(file, 'b.json').then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('DEADLOCK'), 1000)),
    ]);
    expect(outcome).toBe('done');
    expect(await library.readText(file)).toBe('saved first');
    const other = await library.createFile(library.tree.rootId, 'c.json', '');
    await library.remove([other]);
    expect(library.tree.nodes[other]).toBeUndefined();
  });
});

describe('FileLibrary — binary policy (videos)', () => {
  async function videoLibrary() {
    const store = createMemoryStore();
    const library = new FileLibrary({ store, policy: videoPolicy });
    await library.init();
    return { library, store };
  }

  it('greys nothing it should open and lists everything else', async () => {
    const { library } = await videoLibrary();
    const root = await makeFolder({ 'show/ep01.MKV': 'v', 'show/ep01.srt': 's', 'film.mp4': 'v' });
    await library.link(root);
    expect(library.unlinkSummary()).toEqual({ folders: 1, openable: 2, otherFiles: 1 });
  });

  it('UNLINK keeps the folder structure but never copies a video into memory', async () => {
    const { library } = await videoLibrary();
    const root = await makeFolder({ 'show/ep01.mkv': 'video bytes', 'film.mp4': 'video bytes' });
    await library.link(root);
    await library.unlink();
    expect(library.mode.kind).toBe('memory');
    expect(findByPath(library.tree, ['show'])).toBeDefined();
    expect(findByPath(library.tree, ['show', 'ep01.mkv'])).toBeUndefined();
    expect(findByPath(library.tree, ['film.mp4'])).toBeUndefined();
  });

  it('a deleted video is not held for undo, and undo never recreates it empty', async () => {
    const { library } = await videoLibrary();
    const root = await makeFolder({ 'film.mp4': 'video bytes' });
    await library.link(root);
    const film = findByPath(library.tree, ['film.mp4'])!.id;
    await library.remove([film]);
    expect(await readDisk(root, 'film.mp4')).toBeUndefined();
    expect(await library.undoDelete()).toEqual([]);
    expect(findByPath(library.tree, ['film.mp4'])).toBeUndefined();
  });

  it("scans with the policy's own hidden rule", async () => {
    const store = createMemoryStore();
    const library = new FileLibrary({
      store,
      policy: extensionPolicy({
        openable: ['.mp4'],
        content: 'binary',
        isHidden: (name) => name.startsWith('.') || name === 'Thumbs.db' || name.endsWith('.part'),
      }),
    });
    await library.init();
    const root = await makeFolder({ 'a.mp4': 'v', 'Thumbs.db': 'x', 'b.mp4.part': 'x', 'node_modules/x.mp4': 'v' });
    await library.link(root);
    expect(findByPath(library.tree, ['a.mp4'])).toBeDefined();
    expect(findByPath(library.tree, ['Thumbs.db'])).toBeUndefined();
    expect(findByPath(library.tree, ['b.mp4.part'])).toBeUndefined();
    // The custom rule REPLACES the default: node_modules is no longer skipped.
    expect(findByPath(library.tree, ['node_modules', 'x.mp4'])).toBeDefined();
  });
});
