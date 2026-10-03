/**
 * What a tab IS. A tab id is `"<kind>:<key>"`:
 *
 *   file:3f9c…      a library file, keyed by its stable node id
 *   welcome:        a page; the empty key makes it a singleton
 *   share:s_9f2c    an app-defined tab no file backs (a remote stream)
 *
 * The tabs reducer never looks inside an id; kinds matter only where a tab
 * meets the outside world — persistence here, labels and close policy in
 * the workspace and the UI.
 */

type TabId = string;

interface TabKind {
  /**
   * How the tab survives a reload:
   *  - `'file'`: by the file's PATH (node ids of a linked folder are rebuilt
   *    on every scan); a file that no longer exists drops out.
   *  - `'key'`: by its key, as-is (Welcome).
   *  - `false`: never (a live stream that ended with the session).
   */
  persist: 'file' | 'key' | false;
  /** Ids this kind had before kinds existed, still found in stored records
   *  (Nodestra stored its Welcome tab as `'@welcome'`). */
  legacyIds?: readonly string[];
}

type TabKinds = Readonly<Record<string, TabKind>>;

const SEPARATOR = ':';

function tabId(kind: string, key = ''): TabId {
  if (kind.length === 0 || kind.includes(SEPARATOR)) {
    throw new Error(`A tab kind must be a non-empty name without "${SEPARATOR}": "${kind}".`);
  }
  return `${kind}${SEPARATOR}${key}`;
}

/** `null` for a string that is not a tab id. The key may itself contain ':'. */
function parseTabId(id: string): { kind: string; key: string } | null {
  const at = id.indexOf(SEPARATOR);
  if (at <= 0) return null;
  return { kind: id.slice(0, at), key: id.slice(at + 1) };
}

/** Typed helper so an app's kinds are checked where they are declared. */
function defineTabKinds<K extends string>(kinds: Record<K, TabKind>): Readonly<Record<K, TabKind>> {
  const fileKinds = Object.entries<TabKind>(kinds).filter(([, kind]) => kind.persist === 'file');
  if (fileKinds.length > 1) {
    throw new Error(
      `Only one tab kind can persist files by path; found ${fileKinds.map(([name]) => name).join(', ')}.`,
    );
  }
  for (const name of Object.keys(kinds)) tabId(name); // validates the name
  return kinds;
}

export { defineTabKinds, parseTabId, tabId };
export type { TabId, TabKind, TabKinds };
