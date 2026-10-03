/**
 * The folder backend against an in-memory File System Access implementation
 * (memfs's `fsa`, a devDependency only).
 *
 * The fake is deliberately made to behave like STABLE CHROME where the two
 * differ: Chrome has no directory `move()` at all (it is undefined in 153),
 * so any `move` the fake exposes is removed. A test that passes only because
 * the fake is more capable than the browser would be worse than no test.
 */

import { describe, expect, it } from 'vitest';
import { fsa } from 'memfs/lib/fsa';
import {
  ConflictError,
  FolderBackend,
  MemoryBackend,
  scanFolder,
} from '../core/backends';
import { createMemoryStore } from '../core/keyValueStore';
import {
  addNode,
  createEmptyTree,
  findByPath,
  moveNode,
  pathOf,
  removeNode,
  renameNode,
} from '../core/libraryTree';

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
  stripMove(root);
  return root;
}

/** Make every handle as incapable as stable Chrome: no `move`. */
function stripMove(root: Dir): void {
  const proto = Object.getPrototypeOf(root) as { move?: unknown };
  if ('move' in proto) delete proto.move;
}

async function listing(root: Dir, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const [name, handle] of root.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      out[path] = await (await (handle as FileSystemFileHandle).getFile()).text();
    } else {
      out[`${path}/`] = '';
      Object.assign(out, await listing(handle as Dir, path));
    }
  }
  return out;
}

describe('scanFolder', () => {
  it('reads every visible entry, skips hidden ones, and keeps non-JSON files', async () => {
    const root = await makeFolder({
      'drums/kick.json': '{}',
      'drums/kick.wav': 'RIFF',
      'notes.txt': 'hi',
      '.git/HEAD': 'ref',
      'song.json': '{}',
      'song.json.crswap': '',
    });
    const tree = (await scanFolder(root)).tree;
    const paths = Object.values(tree.nodes)
      .filter((node) => node.parentId !== null)
      .map((node) => pathOf(tree, node.id).join('/'))
      .sort();
    expect(paths).toEqual(['drums', 'drums/kick.json', 'drums/kick.wav', 'notes.txt', 'song.json']);
  });

  it('lends previous ids to entries at the same path on a re-scan', async () => {
    const root = await makeFolder({ 'a/b.json': '{}', 'c.json': '{}' });
    const first = (await scanFolder(root)).tree;
    const b = findByPath(first, ['a', 'b.json'])!.id;
    const second = (await scanFolder(root, first)).tree;
    expect(findByPath(second, ['a', 'b.json'])!.id).toBe(b);
  });
});

describe('FolderBackend', () => {
  it('creates, reads and overwrites files; creates folders', async () => {
    const root = await makeFolder({});
    const backend = new FolderBackend(root);
    let tree = createEmptyTree();
    const folder = addNode(tree, tree.rootId, 'folder', 'drums');
    tree = folder.tree;
    await backend.createFolder(tree, folder.id);
    const file = addNode(tree, folder.id, 'file', 'kick.json');
    tree = file.tree;
    await backend.write(tree, file.id, 'one');
    await backend.write(tree, file.id, 'two');
    expect(await backend.readText(tree, file.id)).toBe('two');
    expect(await listing(root)).toEqual({ 'drums/': '', 'drums/kick.json': 'two' });
  });

  it('renames and moves a FILE, falling back to copy + delete without move()', async () => {
    const root = await makeFolder({ 'drums/kick.json': 'k', 'snare.json': 's' });
    const backend = new FolderBackend(root);
    const before = (await scanFolder(root)).tree;
    const kick = findByPath(before, ['drums', 'kick.json'])!.id;
    const renamed = renameNode(before, kick, 'boom.json');
    await backend.relocate(before, renamed, kick);
    const moved = moveNode(renamed, kick, renamed.rootId);
    await backend.relocate(renamed, moved, kick);
    expect(await listing(root)).toEqual({ 'drums/': '', 'boom.json': 'k', 'snare.json': 's' });
  });

  it('renames and moves a FOLDER by copy then delete, contents intact', async () => {
    const root = await makeFolder({
      'drums/kick.json': 'k',
      'drums/deep/sub.json': 's',
      'drums/kick.wav': 'RIFF',
      'target/x.json': 'x',
    });
    const backend = new FolderBackend(root);
    const before = (await scanFolder(root)).tree;
    const drums = findByPath(before, ['drums'])!.id;
    const target = findByPath(before, ['target'])!.id;
    const renamed = renameNode(before, drums, 'percussion');
    await backend.relocate(before, renamed, drums);
    const moved = moveNode(renamed, drums, target);
    await backend.relocate(renamed, moved, drums);
    expect(await listing(root)).toEqual({
      'target/': '',
      'target/x.json': 'x',
      'target/percussion/': '',
      'target/percussion/kick.json': 'k',
      'target/percussion/kick.wav': 'RIFF',
      'target/percussion/deep/': '',
      'target/percussion/deep/sub.json': 's',
    });
  });

  it('performs a case-only rename of a file and a folder', async () => {
    const root = await makeFolder({ 'drums/kick.json': 'k' });
    const backend = new FolderBackend(root);
    const before = (await scanFolder(root)).tree;
    const kick = findByPath(before, ['drums', 'kick.json'])!.id;
    const drums = findByPath(before, ['drums'])!.id;
    const fileRenamed = renameNode(before, kick, 'Kick.json');
    await backend.relocate(before, fileRenamed, kick);
    const folderRenamed = renameNode(fileRenamed, drums, 'Drums');
    await backend.relocate(fileRenamed, folderRenamed, drums);
    expect(await listing(root)).toEqual({ 'Drums/': '', 'Drums/Kick.json': 'k' });
  });

  it('refuses to relocate onto a HIDDEN entry the tree cannot see', async () => {
    // `node_modules` is hidden from the tree but is a legal name, so only the
    // disk-level check can stop a rename from colliding with it.
    const root = await makeFolder({ 'a/x.json': 'x', 'node_modules/pkg.json': '{}' });
    const backend = new FolderBackend(root);
    const before = (await scanFolder(root)).tree;
    const a = findByPath(before, ['a'])!.id;
    const renamed = renameNode(before, a, 'node_modules');
    await expect(backend.relocate(before, renamed, a)).rejects.toThrow(/already exists/);
    expect((await listing(root))['node_modules/pkg.json']).toBe('{}');
  });

  it('never overwrites an unseen file when CREATING', async () => {
    const root = await makeFolder({ 'song.json': 'theirs' });
    const backend = new FolderBackend(root);
    // A tree that has not seen song.json (made before the file appeared).
    const tree = addNode(createEmptyTree(), 'root', 'file', 'song.json');
    await expect(
      backend.write(tree.tree, tree.id, 'mine', { create: true }),
    ).rejects.toThrow(/already exists/);
    expect((await listing(root))['song.json']).toBe('theirs');
  });

  it('refreshes conflict records after a FOLDER move (no false conflict)', async () => {
    const root = await makeFolder({ 'drums/kick.json': 'k' });
    const backend = new FolderBackend(root);
    const before = (await scanFolder(root)).tree;
    const kick = findByPath(before, ['drums', 'kick.json'])!.id;
    const drums = findByPath(before, ['drums'])!.id;
    await backend.readText(before, kick);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = renameNode(before, drums, 'percussion');
    await backend.relocate(before, after, drums);
    await expect(backend.write(after, kick, 'k2')).resolves.toBeUndefined();
  });

  it('deletes a folder recursively', async () => {
    const root = await makeFolder({ 'drums/kick.json': 'k', 'keep.json': 'x' });
    const backend = new FolderBackend(root);
    const before = (await scanFolder(root)).tree;
    const drums = findByPath(before, ['drums'])!.id;
    await backend.remove(before, drums);
    expect(await listing(root)).toEqual({ 'keep.json': 'x' });
    expect(removeNode(before, drums).removed.length).toBe(2);
  });

  it('detects a file changed outside the app, and force overrides it', async () => {
    const root = await makeFolder({ 'a.json': 'mine' });
    const backend = new FolderBackend(root);
    const tree = (await scanFolder(root)).tree;
    const a = findByPath(tree, ['a.json'])!.id;
    await backend.readText(tree, a);
    // Another program writes the file later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const handle = await root.getFileHandle('a.json');
    const writable = await handle.createWritable();
    await writable.write('theirs');
    await writable.close();
    await expect(backend.write(tree, a, 'mine 2')).rejects.toBeInstanceOf(ConflictError);
    await backend.write(tree, a, 'mine 2', { force: true });
    expect(await backend.readText(tree, a)).toBe('mine 2');
  });
});

describe('MemoryBackend', () => {
  it('keys contents by id, so rename and move never touch them', async () => {
    const backend = new MemoryBackend(createMemoryStore());
    let tree = createEmptyTree();
    const file = addNode(tree, tree.rootId, 'file', 'a.json');
    tree = file.tree;
    await backend.write(tree, file.id, 'content');
    const renamed = renameNode(tree, file.id, 'b.json');
    await backend.relocate(tree, renamed, file.id);
    expect(await backend.readText(renamed, file.id)).toBe('content');
    await backend.remove(renamed, file.id);
    await expect(backend.readText(renamed, file.id)).rejects.toThrow();
  });

  it('persists and clears the structure', async () => {
    const backend = new MemoryBackend(createMemoryStore());
    const tree = addNode(createEmptyTree(), 'root', 'file', 'a.json').tree;
    await backend.saveStructure(tree);
    expect(await backend.loadStructure()).toContain('a.json');
    await backend.clear();
    expect(await backend.loadStructure()).toBeUndefined();
  });
});

/**
 * Chrome's directory listing silently OMITS names it will not expose to
 * websites (`.lnk`, `.url`, `.scf`, dangerous executables, `~`-names…):
 * Chromium's `DidReadDirectory` skips any child failing
 * `IsSafePathComponent`. A copy made from the listing therefore misses them,
 * and a recursive delete of the original would erase them for good
 * (review/2026-09-26-library FB-01). The fake is made to hide `.url` files
 * the same way; everything else about it is unchanged.
 */
describe('files the browser hides are never deleted', () => {
  async function withHiddenUrlFiles<T>(run: () => Promise<T>): Promise<T> {
    const { dir } = fsa({ mode: 'readwrite' });
    const proto = Object.getPrototypeOf(dir) as {
      entries: (this: Dir) => AsyncIterable<[string, FileSystemHandle]>;
      keys: (this: Dir) => AsyncIterable<string>;
    };
    const originalEntries = proto.entries;
    const originalKeys = proto.keys;
    proto.entries = async function* (this: Dir) {
      for await (const entry of originalEntries.call(this)) {
        if (!entry[0].endsWith('.url')) yield entry;
      }
    };
    proto.keys = async function* (this: Dir) {
      for await (const name of originalKeys.call(this)) {
        if (!name.endsWith('.url')) yield name;
      }
    };
    try {
      return await run();
    } finally {
      proto.entries = originalEntries;
      proto.keys = originalKeys;
    }
  }

  async function exists(root: Dir, path: string[]): Promise<boolean> {
    try {
      let current = root;
      for (const segment of path.slice(0, -1)) current = await current.getDirectoryHandle(segment);
      await current.getFileHandle(path[path.length - 1]);
      return true;
    } catch {
      return false;
    }
  }

  it('a FOLDER RENAME leaves hidden files in the original folder and says so', async () => {
    const root = await makeFolder({ 'drums/kick.json': 'k', 'drums/Sample pack.url': 'link' });
    await withHiddenUrlFiles(async () => {
      const backend = new FolderBackend(root);
      const before = (await scanFolder(root)).tree;
      const drums = findByPath(before, ['drums'])!.id;
      const after = renameNode(before, drums, 'percussion');
      const note = await backend.relocate(before, after, drums);
      expect(note).toMatch(/hidden from websites/);
      expect(await exists(root, ['percussion', 'kick.json'])).toBe(true);
      // The file the app could not see is still there, untouched.
      expect(await exists(root, ['drums', 'Sample pack.url'])).toBe(true);
    });
  });

  it('a FOLDER DELETE removes what it can see and leaves the hidden file', async () => {
    const root = await makeFolder({ 'drums/kick.json': 'k', 'drums/Sample pack.url': 'link' });
    await withHiddenUrlFiles(async () => {
      const backend = new FolderBackend(root);
      const before = (await scanFolder(root)).tree;
      const drums = findByPath(before, ['drums'])!.id;
      const note = await backend.remove(before, drums);
      expect(note).toMatch(/left on disk/);
      expect(await exists(root, ['drums', 'kick.json'])).toBe(false);
      expect(await exists(root, ['drums', 'Sample pack.url'])).toBe(true);
    });
  });
});

