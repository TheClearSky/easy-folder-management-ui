/**
 * The open tabs, remembered across reloads (moved out of the library, which
 * no longer needs to know what a tab is).
 *
 * Stored in the library's own key-value store under `openTabs`, in a format
 * Nodestra's existing records already use for files and pages:
 *
 *   { path: ['drums', 'kick.json'] }   a file tab, by PATH (ids of a linked
 *                                       folder are rebuilt on every scan)
 *   { page: '@welcome' }               a legacy page tab (read, never written)
 *   { kind: 'welcome', key: '' }       any other persisted kind
 *
 * A file that no longer exists, or that the policy no longer opens, drops
 * out on recall. Kinds that do not persist are never written.
 */

import type { FileLibrary } from './fileLibrary';
import { findByPath, isOpenableFile, pathOf } from './libraryTree';
import { parseTabId, tabId } from './tabKinds';
import type { TabId, TabKinds } from './tabKinds';

const OPEN_TABS_KEY = 'openTabs';
/** The single open file of a library from before tabs (read only). */
const LEGACY_ACTIVE_FILE_KEY = 'activeFile';

type TabRecord = {
  order: TabId[];
  active: TabId | null;
  closed: TabId[];
  /** Recently opened FILE tabs, most recent first. */
  recent: TabId[];
  /** The preview (italic) tab, if any. */
  preview: TabId | null;
};

type StoredTab = { path: string[] } | { page: string } | { kind: string; key: string };
type StoredTabs = {
  order: StoredTab[];
  active: StoredTab | null;
  closed: StoredTab[];
  recent?: StoredTab[];
  preview?: StoredTab | null;
};

interface TabRecordStore {
  remember(record: Partial<TabRecord> & Pick<TabRecord, 'order' | 'active'>): Promise<void>;
  /** The remembered tabs resolved against the library's CURRENT tree;
   *  `null` when nothing was ever remembered (a first visit). */
  recall(): Promise<TabRecord | null>;
}

function createTabRecordStore(options: { library: FileLibrary; kinds: TabKinds }): TabRecordStore {
  const { library, kinds } = options;
  const fileKind = Object.keys(kinds).find((name) => kinds[name].persist === 'file');
  const legacyKind = new Map<string, string>();
  for (const [name, kind] of Object.entries(kinds)) {
    for (const legacy of kind.legacyIds ?? []) legacyKind.set(legacy, name);
  }

  const encode = (id: TabId): StoredTab | null => {
    const parsed = parseTabId(id);
    if (!parsed) return null;
    const kind = kinds[parsed.kind];
    if (!kind || kind.persist === false) return null;
    if (kind.persist === 'key') return { kind: parsed.kind, key: parsed.key };
    const node = library.tree.nodes[parsed.key];
    return node ? { path: pathOf(library.tree, node.id) } : null;
  };

  const fileTab = (path: unknown): TabId | null => {
    if (fileKind === undefined) return null;
    if (!Array.isArray(path) || !path.every((segment) => typeof segment === 'string')) return null;
    const node = findByPath(library.tree, path as string[]);
    return node && isOpenableFile(node, library.policy) ? tabId(fileKind, node.id) : null;
  };

  const decode = (entry: unknown): TabId | null => {
    if (!entry || typeof entry !== 'object') return null;
    const { path, page, kind, key } = entry as Record<string, unknown>;
    if (path !== undefined) return fileTab(path);
    if (typeof page === 'string') {
      const name = legacyKind.get(page);
      return name === undefined ? null : tabId(name);
    }
    if (typeof kind === 'string' && typeof key === 'string' && kinds[kind]?.persist === 'key') {
      return tabId(kind, key);
    }
    return null;
  };

  const encodeAll = (ids: readonly TabId[] | undefined) =>
    (ids ?? []).map(encode).filter((entry): entry is StoredTab => entry !== null);
  const decodeAll = (entries: unknown) =>
    Array.isArray(entries) ? entries.map(decode).filter((id): id is TabId => id !== null) : [];
  const isFileTab = (id: TabId) => parseTabId(id)?.kind === fileKind;

  return {
    async remember(record) {
      const stored: StoredTabs = {
        order: encodeAll(record.order),
        active: record.active === null ? null : encode(record.active),
        closed: encodeAll(record.closed),
        recent: encodeAll(record.recent),
        preview: record.preview ? encode(record.preview) : null,
      };
      await library.keyValueStore.set(OPEN_TABS_KEY, stored).catch(() => {});
    },

    async recall() {
      const store = library.keyValueStore;
      const stored = await store.get<StoredTabs>(OPEN_TABS_KEY).catch(() => undefined);
      if (!stored || typeof stored !== 'object' || !Array.isArray(stored.order)) {
        const legacyPath = await store.get<unknown>(LEGACY_ACTIVE_FILE_KEY).catch(() => undefined);
        const legacy = fileTab(legacyPath);
        return legacy
          ? { order: [legacy], active: legacy, closed: [], recent: [legacy], preview: null }
          : null;
      }
      const order = decodeAll(stored.order);
      const active = decode(stored.active);
      const preview = decode(stored.preview);
      return {
        order,
        active: active !== null && order.includes(active) ? active : (order[0] ?? null),
        closed: decodeAll(stored.closed).filter((id) => !order.includes(id)),
        recent: decodeAll(stored.recent).filter(isFileTab),
        preview: preview !== null && order.includes(preview) ? preview : null,
      };
    },
  };
}

export { createTabRecordStore };
export type { TabRecord, TabRecordStore };
