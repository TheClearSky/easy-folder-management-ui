import { describe, expect, it } from 'vitest';
import {
  isHiddenEntry,
  splitExtension,
  toFileName,
  uniqueName,
  validateName,
} from '../core/names';
import {
  addNode,
  childrenOf,
  countContents,
  createEmptyTree,
  deserializeTree,
  findByPath,
  LibraryError,
  moveNode,
  pathOf,
  removeNode,
  renameNode,
  serializeTree,
  topmostOnly,
} from '../core/libraryTree';

import { extensionPolicy } from '../core/policy';

const JSON_POLICY = extensionPolicy({ openable: ['.json'], content: 'text', defaultExtension: '.json' });

describe('library names', () => {
  it('accepts ordinary names and rejects what some OS would refuse', () => {
    expect(validateName('kick.json')).toBeNull();
    expect(validateName('Drums & Bass 2')).toBeNull();
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'trail.', 'trail ', ' lead', 'CON', 'nul.json', 'Com1.txt']) {
      expect(validateName(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it('recognises openable files case-insensitively', () => {
    expect(JSON_POLICY.isOpenable('a.json')).toBe(true);
    expect(JSON_POLICY.isOpenable('A.JSON')).toBe(true);
    expect(JSON_POLICY.isOpenable('a.json.bak')).toBe(false);
    expect(JSON_POLICY.isOpenable('notes.txt')).toBe(false);
  });

  it('hides dot entries, node_modules and Chrome swap files', () => {
    expect(isHiddenEntry('.git')).toBe(true);
    expect(isHiddenEntry('node_modules')).toBe(true);
    expect(isHiddenEntry('kick.json.crswap')).toBe(true);
    expect(isHiddenEntry('kick.json')).toBe(false);
  });

  it('splits extensions the way a rename box should select them', () => {
    expect(splitExtension('kick.json')).toEqual({ stem: 'kick', extension: '.json' });
    expect(splitExtension('a.b.json')).toEqual({ stem: 'a.b', extension: '.json' });
    expect(splitExtension('folder')).toEqual({ stem: 'folder', extension: '' });
    expect(splitExtension('.env')).toEqual({ stem: '.env', extension: '' });
  });

  it('numbers colliding names, ignoring case, continuing an existing counter', () => {
    expect(uniqueName('Untitled.json', [])).toBe('Untitled.json');
    expect(uniqueName('Untitled.json', ['untitled.JSON'])).toBe('Untitled 2.json');
    expect(uniqueName('Untitled.json', ['Untitled.json', 'Untitled 2.json'])).toBe('Untitled 3.json');
    expect(uniqueName('Kick 2.json', ['Kick 2.json'])).toBe('Kick 3.json');
    expect(uniqueName('New folder', ['new folder'])).toBe('New folder 2');
  });

  it('turns any title into a safe file name', () => {
    expect(toFileName('Piano — struck string (hold a key)', '.json')).toBe('Piano — struck string (hold a key).json');
    expect(toFileName('a/b:c*d', '.json')).toBe('a b c d.json');
    expect(toFileName('song.json', '.json')).toBe('song.json');
    expect(toFileName('SONG.JSON', '.json')).toBe('SONG.JSON');
    expect(toFileName('...', '.json')).toBe('Untitled.json');
    expect(toFileName('con', '.json')).toBe('_con.json');
    expect(toFileName('a/b')).toBe('a b');
  });
});

function sampleTree() {
  let tree = createEmptyTree();
  const drums = addNode(tree, tree.rootId, 'folder', 'drums');
  tree = drums.tree;
  const kick = addNode(tree, drums.id, 'file', 'kick.json');
  tree = kick.tree;
  const snare = addNode(tree, drums.id, 'file', 'Snare.json');
  tree = snare.tree;
  const notes = addNode(tree, tree.rootId, 'file', 'notes.txt');
  tree = notes.tree;
  const song = addNode(tree, tree.rootId, 'file', 'song.json');
  tree = song.tree;
  return { tree, drums: drums.id, kick: kick.id, snare: snare.id, notes: notes.id, song: song.id };
}

describe('library tree', () => {
  it('keeps folders first and names in natural, case-insensitive order', () => {
    let { tree } = sampleTree();
    tree = addNode(tree, tree.rootId, 'file', 'Kick 10.json').tree;
    tree = addNode(tree, tree.rootId, 'file', 'kick 2.json').tree;
    const names = childrenOf(tree, tree.rootId).map((id) => tree.nodes[id].name);
    expect(names).toEqual(['drums', 'kick 2.json', 'Kick 10.json', 'notes.txt', 'song.json']);
  });

  it('refuses a name that collides ignoring case, but allows a case-only rename', () => {
    const { tree, drums, kick } = sampleTree();
    expect(() => addNode(tree, drums, 'file', 'KICK.json')).toThrow(LibraryError);
    const renamed = renameNode(tree, kick, 'Kick.json');
    expect(renamed.nodes[kick].name).toBe('Kick.json');
    expect(() => renameNode(tree, kick, 'snare.json')).toThrow(/already exists/);
  });

  it('keeps ids stable across rename and move, so the path is derived', () => {
    const { tree, drums, kick } = sampleTree();
    let next = renameNode(tree, kick, 'boom.json');
    next = moveNode(next, kick, next.rootId);
    expect(next.nodes[kick].name).toBe('boom.json');
    expect(pathOf(next, kick)).toEqual(['boom.json']);
    expect(pathOf(tree, kick)).toEqual(['drums', 'kick.json']); // input untouched
    expect(childrenOf(next, drums).map((id) => next.nodes[id].name)).toEqual(['Snare.json']);
  });

  it('refuses to move a folder into itself or a descendant', () => {
    let { tree, drums } = sampleTree();
    const inner = addNode(tree, drums, 'folder', 'inner');
    tree = inner.tree;
    expect(() => moveNode(tree, drums, drums)).toThrow(/into itself/);
    expect(() => moveNode(tree, drums, inner.id)).toThrow(/into itself/);
  });

  it('refuses to place anything inside a file', () => {
    const { tree, song, kick } = sampleTree();
    expect(() => moveNode(tree, kick, song)).toThrow(/inside a folder/);
  });

  it('removes a whole subtree and reports every removed id', () => {
    const { tree, drums, kick, snare } = sampleTree();
    const { tree: next, removed } = removeNode(tree, drums);
    expect(new Set(removed)).toEqual(new Set([drums, kick, snare]));
    expect(next.nodes[kick]).toBeUndefined();
    expect(next.children[drums]).toBeUndefined();
  });

  it('finds by path ignoring case', () => {
    const { tree, kick } = sampleTree();
    expect(findByPath(tree, ['DRUMS', 'Kick.JSON'])?.id).toBe(kick);
    expect(findByPath(tree, ['drums', 'nope.json'])).toBeUndefined();
  });

  it('keeps only the top-most items of a selection', () => {
    const { tree, drums, kick, song } = sampleTree();
    expect(new Set(topmostOnly(tree, [kick, drums, song]))).toEqual(new Set([drums, song]));
  });

  it('round-trips through storage and rejects a corrupt blob', () => {
    const { tree, kick } = sampleTree();
    const restored = deserializeTree(serializeTree(tree));
    expect(restored).toBeDefined();
    expect(pathOf(restored!, kick)).toEqual(['drums', 'kick.json']);
    expect(childrenOf(restored!, restored!.rootId)).toEqual(childrenOf(tree, tree.rootId));
    expect(deserializeTree('{"version":1,"rootId":"root","nodes":{}}')).toBeUndefined();
    expect(deserializeTree('not json')).toBeUndefined();
  });

  it('counts openable files, folders and other files', () => {
    const { tree } = sampleTree();
    expect(countContents(tree, JSON_POLICY)).toEqual({ folders: 1, openable: 3, otherFiles: 1 });
  });
});
