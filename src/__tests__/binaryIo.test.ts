/**
 * Binary-safe I/O: disk-backed files, streamed writes, resumed writes, Blob
 * storage in the browser store, and read-only links. The folder is memfs's
 * File System Access implementation with `move` stripped (stable Chrome).
 */

import { describe, expect, it } from 'vitest';
import { fsa } from 'memfs/lib/fsa';
import { FileLibrary } from '../core/fileLibrary';
import { createMemoryStore } from '../core/keyValueStore';
import { findByPath } from '../core/libraryTree';
import { extensionPolicy } from '../core/policy';

type Dir = FileSystemDirectoryHandle;

const videoPolicy = extensionPolicy({ openable: ['.mp4', '.mkv'], content: 'binary' });

async function makeFolder(files: Record<string, string | Uint8Array>): Promise<Dir> {
  const { dir } = fsa({ mode: 'readwrite' });
  const root = dir as unknown as Dir;
  for (const [path, data] of Object.entries(files)) {
    const segments = path.split('/');
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    const handle = await current.getFileHandle(segments[segments.length - 1], { create: true });
    const writable = await handle.createWritable();
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  }
  const proto = Object.getPrototypeOf(root) as { move?: unknown };
  if ('move' in proto) delete proto.move;
  return root;
}

async function diskBytes(root: Dir, path: string): Promise<Uint8Array | undefined> {
  const segments = path.split('/');
  try {
    let current = root;
    for (const segment of segments.slice(0, -1)) current = await current.getDirectoryHandle(segment);
    const file = await (await current.getFileHandle(segments[segments.length - 1])).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return undefined;
  }
}

/** A stream that yields `chunks` one at a time, counting how many were pulled. */
function chunkStream(chunks: Uint8Array[]) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks.length) controller.close();
      else controller.enqueue(chunks[pulled++]);
    },
  });
  return { stream, pulled: () => pulled };
}

const bytes = (...values: number[]) => new Uint8Array(values);

async function linked(files: Record<string, string | Uint8Array>, access?: 'read' | 'readwrite') {
  const library = new FileLibrary({ store: createMemoryStore(), policy: videoPolicy, access });
  await library.init();
  const root = await makeFolder(files);
  await library.link(root);
  return { library, root };
}

describe('binary I/O — linked folder', () => {
  it('getFile returns the file without reading it as text', async () => {
    const { library } = await linked({ 'film.mp4': bytes(0, 1, 2, 255) });
    const file = await library.getFile(findByPath(library.tree, ['film.mp4'])!.id);
    expect(file.name).toBe('film.mp4');
    expect(file.size).toBe(4);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes(0, 1, 2, 255));
  });

  it('creates a file from a stream, consuming it chunk by chunk', async () => {
    const { library, root } = await linked({});
    const { stream, pulled } = chunkStream([bytes(1, 2), bytes(3), bytes(4, 5, 6)]);
    const id = await library.createFile(library.tree.rootId, 'copy.mkv', stream);
    expect(pulled()).toBe(3);
    expect(await diskBytes(root, 'copy.mkv')).toEqual(bytes(1, 2, 3, 4, 5, 6));
    expect((await library.getFile(id)).size).toBe(6);
  });

  it('resumes a write at an offset, keeping the bytes before it', async () => {
    const { library, root } = await linked({ 'part.mp4': bytes(1, 2, 3, 9, 9) });
    const id = findByPath(library.tree, ['part.mp4'])!.id;
    await library.getFile(id); // seen: the conflict check knows this version
    await library.write(id, chunkStream([bytes(4, 5)]).stream, { at: 3 });
    expect(await diskBytes(root, 'part.mp4')).toEqual(bytes(1, 2, 3, 4, 5));
  });

  // That the previous contents SURVIVE is the browser's guarantee (writes go
  // to a swap file committed on close), which memfs does not model — it
  // truncates on createWritable. Verified in Chrome 2026-10-01 against OPFS:
  // a stream failing mid-pipe left [7,7,7] intact (research note G4b). Here:
  // the failure must surface, and the writable must be released, not closed.
  it('a failing stream rejects and releases the file', async () => {
    const { library, root } = await linked({ 'keep.mp4': bytes(7, 7, 7) });
    const id = findByPath(library.tree, ['keep.mp4'])!.id;
    await library.getFile(id);
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes(1));
        controller.error(new Error('peer disconnected'));
      },
    });
    await expect(library.write(id, failing)).rejects.toThrow('peer disconnected');
    // Released: the next write succeeds (an unreleased writable would lock it).
    await library.write(id, bytes(8), { force: true });
    expect(await diskBytes(root, 'keep.mp4')).toEqual(bytes(8));
  });

  it('moves a folder of binary files byte for byte (streamed copy)', async () => {
    const { library, root } = await linked({ 'show/ep01.mkv': bytes(0, 128, 255), 'season': '' });
    const show = findByPath(library.tree, ['show'])!.id;
    await library.rename(show, 'Show S1');
    expect(await diskBytes(root, 'Show S1/ep01.mkv')).toEqual(bytes(0, 128, 255));
    expect(await diskBytes(root, 'show/ep01.mkv')).toBeUndefined();
  });
});

describe('binary I/O — browser store', () => {
  it('keeps text as text and bytes as a Blob, both readable as files', async () => {
    const library = new FileLibrary({ store: createMemoryStore(), policy: videoPolicy });
    await library.init();
    const clip = await library.createFile(library.tree.rootId, 'clip.mp4', bytes(5, 6, 7));
    const note = await library.createFile(library.tree.rootId, 'note.txt', 'hello');
    expect(new Uint8Array(await (await library.getFile(clip)).arrayBuffer())).toEqual(bytes(5, 6, 7));
    expect(await library.readText(note)).toBe('hello');
    expect((await library.getFile(note)).name).toBe('note.txt');
  });

  it('resumes a write at an offset', async () => {
    const library = new FileLibrary({ store: createMemoryStore(), policy: videoPolicy });
    await library.init();
    const id = await library.createFile(library.tree.rootId, 'a.mp4', bytes(1, 2, 3, 0));
    await library.write(id, bytes(4, 5), { at: 3 });
    expect(new Uint8Array(await (await library.getFile(id)).arrayBuffer())).toEqual(bytes(1, 2, 3, 4, 5));
  });
});

describe('read-only link', () => {
  it('lists and reads, and refuses every change', async () => {
    const { library, root } = await linked({ 'film.mp4': bytes(1), 'show/ep.mkv': bytes(2) }, 'read');
    expect(library.mode.kind).toBe('folder');
    expect(library.writable).toBe(false);
    const film = findByPath(library.tree, ['film.mp4'])!.id;
    expect((await library.getFile(film)).size).toBe(1);
    await expect(library.createFile(library.tree.rootId, 'x.mp4', 'x')).rejects.toThrow('read-only');
    await expect(library.createFolder(library.tree.rootId, 'new')).rejects.toThrow('read-only');
    await expect(library.rename(film, 'renamed.mp4')).rejects.toThrow('read-only');
    await expect(library.write(film, bytes(9))).rejects.toThrow('read-only');
    await expect(library.remove([film])).rejects.toThrow('read-only');
    expect(await diskBytes(root, 'film.mp4')).toEqual(bytes(1));
  });
});

describe('write-access upgrade', () => {
  it('a read-only link becomes writable after requestWriteAccess', async () => {
    const { library, root } = await linked({ 'film.mp4': bytes(1) }, 'read');
    await expect(library.createFile(library.tree.rootId, 'copy.mp4', bytes(2))).rejects.toThrow('read-only');
    // memfs has no permission API, which the library treats as granted.
    expect(await library.requestWriteAccess()).toBe(true);
    expect(library.access).toBe('readwrite');
    expect(library.writable).toBe(true);
    await library.createFile(library.tree.rootId, 'copy.mp4', bytes(2));
    expect(await diskBytes(root, 'copy.mp4')).toEqual(bytes(2));
  });

  it('the in-browser store is writable without asking', async () => {
    const library = new FileLibrary({ store: createMemoryStore(), policy: videoPolicy, access: 'read' });
    await library.init();
    expect(await library.requestWriteAccess()).toBe(true);
  });
});
