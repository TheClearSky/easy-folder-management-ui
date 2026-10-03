/**
 * The graph library's TREE — pure data, no storage, no React.
 *
 * Every node has a stable `id` that survives renames and moves. Identity is
 * NEVER the path: the save controller addresses "the file I was editing" by
 * id, so renaming or moving that file while an edit is pending still saves
 * to the right place (a path captured before a rename points at nothing
 * after it; see `research/2026-09-26-file-library/app-integration.md` §2).
 *
 * Every operation returns a NEW tree and never mutates its input, so a
 * caller can keep the previous tree to describe the change to a storage
 * backend ("this was at a/b.json, it is now at c/b.json") and discard the
 * new one if the backend refuses.
 */

import { nameKey, sameName, validateName } from './names';
import type { FilePolicy } from './policy';

type LibraryNodeKind = 'folder' | 'file';

type LibraryNode = {
  id: string;
  kind: LibraryNodeKind;
  name: string;
  /** `null` only for the root. */
  parentId: string | null;
};

type LibraryTree = {
  rootId: string;
  nodes: Readonly<Record<string, LibraryNode>>;
  /** Parent id → child ids, kept SORTED (see `sortChildren`). */
  children: Readonly<Record<string, readonly string[]>>;
};

/** A refusal the UI can show verbatim. */
class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryError';
  }
}

let fallbackCounter = 0;

function newNodeId(): string {
  // crypto.randomUUID needs a secure context; the fallback keeps unit tests
  // and odd embeddings working (ids only need to be unique per library).
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  fallbackCounter += 1;
  return `node-${Date.now().toString(36)}-${fallbackCounter}`;
}

const ROOT_ID = 'root';

function createEmptyTree(): LibraryTree {
  return {
    rootId: ROOT_ID,
    nodes: { [ROOT_ID]: { id: ROOT_ID, kind: 'folder', name: '', parentId: null } },
    children: { [ROOT_ID]: [] },
  };
}

/** Folders first, then natural, case-insensitive name order ("Kick 2" before
 *  "Kick 10") — the explorer convention. */
function compareNodes(a: LibraryNode, b: LibraryNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return nameKey(a.name).localeCompare(nameKey(b.name), undefined, {
    numeric: true,
  });
}

function sortChildren(
  nodes: Readonly<Record<string, LibraryNode>>,
  ids: readonly string[],
): string[] {
  return [...ids].sort((a, b) => compareNodes(nodes[a], nodes[b]));
}

function getNode(tree: LibraryTree, id: string): LibraryNode {
  const node = tree.nodes[id];
  if (!node) throw new LibraryError('That item no longer exists.');
  return node;
}

function childrenOf(tree: LibraryTree, id: string): readonly string[] {
  return tree.children[id] ?? [];
}

function childNamed(
  tree: LibraryTree,
  parentId: string,
  name: string,
): LibraryNode | undefined {
  for (const childId of childrenOf(tree, parentId)) {
    const child = tree.nodes[childId];
    if (sameName(child.name, name)) return child;
  }
  return undefined;
}

/** Names from the root down, root excluded: `["drums", "kick.json"]`. */
function pathOf(tree: LibraryTree, id: string): string[] {
  const segments: string[] = [];
  let current: LibraryNode | undefined = tree.nodes[id];
  while (current && current.parentId !== null) {
    segments.unshift(current.name);
    current = tree.nodes[current.parentId];
  }
  return segments;
}

/** The node at a root-relative path, compared case-insensitively. */
function findByPath(
  tree: LibraryTree,
  segments: readonly string[],
): LibraryNode | undefined {
  let current: LibraryNode | undefined = tree.nodes[tree.rootId];
  for (const segment of segments) {
    if (!current) return undefined;
    current = childNamed(tree, current.id, segment);
  }
  return current;
}

/** Every id under `id`, `id` itself first. */
function subtreeIds(tree: LibraryTree, id: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    out.push(current);
    for (const child of childrenOf(tree, current)) walk(child);
  };
  walk(id);
  return out;
}

/** A file the app opens (per its policy); folders never are. */
function isOpenableFile(node: LibraryNode, policy: FilePolicy): boolean {
  return node.kind === 'file' && policy.isOpenable(node.name);
}

function assertNameFree(
  tree: LibraryTree,
  parentId: string,
  name: string,
  exceptId?: string,
): void {
  const problem = validateName(name);
  if (problem) throw new LibraryError(problem);
  const clash = childNamed(tree, parentId, name);
  if (clash && clash.id !== exceptId) {
    throw new LibraryError(
      `"${clash.name}" already exists here. Names are compared ignoring case.`,
    );
  }
}

function assertFolder(tree: LibraryTree, id: string): void {
  if (getNode(tree, id).kind !== 'folder') {
    throw new LibraryError('Items can only be placed inside a folder.');
  }
}

function addNode(
  tree: LibraryTree,
  parentId: string,
  kind: LibraryNodeKind,
  name: string,
  id: string = newNodeId(),
): { tree: LibraryTree; id: string } {
  assertFolder(tree, parentId);
  assertNameFree(tree, parentId, name);
  const node: LibraryNode = { id, kind, name, parentId };
  const nodes = { ...tree.nodes, [id]: node };
  const children: Record<string, readonly string[]> = {
    ...tree.children,
    [parentId]: sortChildren(nodes, [...childrenOf(tree, parentId), id]),
  };
  if (kind === 'folder') children[id] = [];
  return { tree: { rootId: tree.rootId, nodes, children }, id };
}

function renameNode(tree: LibraryTree, id: string, name: string): LibraryTree {
  const node = getNode(tree, id);
  if (node.parentId === null) throw new LibraryError('The root cannot be renamed.');
  if (node.name === name) return tree;
  // A case-only rename ("kick" → "Kick") is allowed: the clash is itself.
  assertNameFree(tree, node.parentId, name, id);
  const nodes = { ...tree.nodes, [id]: { ...node, name } };
  return {
    rootId: tree.rootId,
    nodes,
    children: {
      ...tree.children,
      [node.parentId]: sortChildren(nodes, childrenOf(tree, node.parentId)),
    },
  };
}

function moveNode(tree: LibraryTree, id: string, targetParentId: string): LibraryTree {
  const node = getNode(tree, id);
  if (node.parentId === null) throw new LibraryError('The root cannot be moved.');
  if (node.parentId === targetParentId) return tree;
  assertFolder(tree, targetParentId);
  if (subtreeIds(tree, id).includes(targetParentId)) {
    throw new LibraryError('A folder cannot be moved into itself.');
  }
  assertNameFree(tree, targetParentId, node.name, id);
  const nodes = { ...tree.nodes, [id]: { ...node, parentId: targetParentId } };
  return {
    rootId: tree.rootId,
    nodes,
    children: {
      ...tree.children,
      [node.parentId]: childrenOf(tree, node.parentId).filter((child) => child !== id),
      [targetParentId]: sortChildren(nodes, [...childrenOf(tree, targetParentId), id]),
    },
  };
}

/** Removes `id` and everything under it. Returns the removed ids too. */
function removeNode(
  tree: LibraryTree,
  id: string,
): { tree: LibraryTree; removed: string[] } {
  const node = getNode(tree, id);
  if (node.parentId === null) throw new LibraryError('The root cannot be deleted.');
  const removed = subtreeIds(tree, id);
  const gone = new Set(removed);
  const nodes: Record<string, LibraryNode> = {};
  for (const [key, value] of Object.entries(tree.nodes)) {
    if (!gone.has(key)) nodes[key] = value;
  }
  const children: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(tree.children)) {
    if (!gone.has(key)) children[key] = value;
  }
  children[node.parentId] = childrenOf(tree, node.parentId).filter(
    (child) => child !== id,
  );
  return { tree: { rootId: tree.rootId, nodes, children }, removed };
}

/**
 * Of a multi-selection, only the TOP-MOST items: moving or deleting a folder
 * already carries its selected descendants, and acting on them again would
 * move them out of the folder or delete them twice.
 */
function topmostOnly(tree: LibraryTree, ids: readonly string[]): string[] {
  const selected = new Set(ids.filter((id) => tree.nodes[id]));
  return [...selected].filter((id) => {
    let parent = tree.nodes[id].parentId;
    while (parent !== null) {
      if (selected.has(parent)) return false;
      parent = tree.nodes[parent].parentId;
    }
    return true;
  });
}

/**
 * Build a tree from a flat node map in one pass: children are derived from
 * parent links and each folder is sorted ONCE. The stored form carries no
 * redundant index that could disagree with the links. Linear (plus the
 * sorts) — used for large folder scans, where `addNode` per entry was
 * quadratic.
 */
function treeFromNodes(
  rootId: string,
  nodes: Record<string, LibraryNode>,
): LibraryTree {
  const childIds: Record<string, string[]> = {};
  for (const node of Object.values(nodes)) {
    if (node.kind === 'folder') childIds[node.id] ??= [];
    if (node.parentId !== null) (childIds[node.parentId] ??= []).push(node.id);
  }
  const children: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(childIds)) {
    children[key] = sortChildren(nodes, value);
  }
  return { rootId, nodes, children };
}

/** The tree as plain JSON (for storage) and back, validated. */
function serializeTree(tree: LibraryTree): string {
  return JSON.stringify({ version: 1, rootId: tree.rootId, nodes: tree.nodes });
}

function deserializeTree(json: string): LibraryTree | undefined {
  try {
    const raw = JSON.parse(json) as {
      version?: number;
      rootId?: string;
      nodes?: Record<string, LibraryNode>;
    };
    if (raw.version !== 1 || typeof raw.rootId !== 'string' || !raw.nodes) {
      return undefined;
    }
    const nodes = raw.nodes;
    if (!nodes[raw.rootId] || nodes[raw.rootId].kind !== 'folder') return undefined;
    for (const node of Object.values(nodes)) {
      if (node.parentId !== null && !nodes[node.parentId]) return undefined;
    }
    return treeFromNodes(raw.rootId, nodes);
  } catch {
    return undefined;
  }
}

function countContents(
  tree: LibraryTree,
  policy: FilePolicy,
): {
  folders: number;
  openable: number;
  otherFiles: number;
} {
  let folders = 0;
  let openable = 0;
  let otherFiles = 0;
  for (const node of Object.values(tree.nodes)) {
    if (node.parentId === null) continue;
    if (node.kind === 'folder') folders += 1;
    else if (isOpenableFile(node, policy)) openable += 1;
    else otherFiles += 1;
  }
  return { folders, openable, otherFiles };
}

export {
  addNode,
  childNamed,
  childrenOf,
  countContents,
  createEmptyTree,
  deserializeTree,
  findByPath,
  getNode,
  isOpenableFile,
  LibraryError,
  moveNode,
  newNodeId,
  pathOf,
  removeNode,
  renameNode,
  serializeTree,
  subtreeIds,
  topmostOnly,
  treeFromNodes,
};
export type { LibraryNode, LibraryNodeKind, LibraryTree };
