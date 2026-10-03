/**
 * What kind of files an app works with — the one place the library learns
 * that Nodestra opens `.json` graphs as text while a video app opens `.mp4`
 * files and must never read them into memory.
 *
 * Every rule that used to be "is it a `.json` graph?" asks the policy:
 * which files open (others are shown greyed), which entries a folder scan
 * skips, what extension a new file gets, and which files UNLINK and UNDO are
 * allowed to copy into memory.
 */

import type { LibraryNode } from './libraryTree';
import { isHiddenEntry, nameKey } from './names';

interface FilePolicy {
  /** Files the app opens; every other file is listed but inert. */
  isOpenable(name: string): boolean;
  /** Entries a folder scan skips entirely (never listed, never counted). */
  isHidden(name: string): boolean;
  /** Appended to a new file's name when missing (`".json"`); `undefined`
   *  leaves names free. */
  readonly defaultExtension: string | undefined;
  /** `'text'`: contents are small strings the library may hold in memory.
   *  `'binary'`: contents are only ever streamed (a 4 GB video). */
  readonly content: 'text' | 'binary';
  /** UNLINK copies these files into the browser's store; the rest stay on
   *  disk only. */
  copyOnUnlink(node: LibraryNode): boolean;
  /** A delete keeps these files' contents in memory so it can be undone. */
  keepForUndo(node: LibraryNode): boolean;
}

type ExtensionPolicyOptions = {
  /** Openable extensions, with the dot, any case: `['.mp4', '.mkv']`. */
  openable: readonly string[];
  content: 'text' | 'binary';
  defaultExtension?: string;
  /** Replaces the default scan-skip rule (dot-entries, `node_modules`,
   *  `*.crswap`). */
  isHidden?: (name: string) => boolean;
  copyOnUnlink?: (node: LibraryNode) => boolean;
  keepForUndo?: (node: LibraryNode) => boolean;
};

/**
 * The common policy: a file opens when its extension is listed. Text files
 * travel with UNLINK and survive a deleted-then-undone round trip; binary
 * files never do (copying a video into IndexedDB, or holding it in memory
 * for an undo, is never what a user wants).
 */
function extensionPolicy(options: ExtensionPolicyOptions): FilePolicy {
  const extensions = options.openable.map(nameKey);
  const isOpenable = (name: string) => {
    const key = nameKey(name);
    return extensions.some((extension) => key.endsWith(extension));
  };
  const textAndOpenable = (node: LibraryNode) =>
    options.content === 'text' && node.kind === 'file' && isOpenable(node.name);
  return {
    isOpenable,
    isHidden: options.isHidden ?? isHiddenEntry,
    defaultExtension: options.defaultExtension,
    content: options.content,
    copyOnUnlink: options.copyOnUnlink ?? textAndOpenable,
    keepForUndo: options.keepForUndo ?? textAndOpenable,
  };
}

export { extensionPolicy };
export type { ExtensionPolicyOptions, FilePolicy };
