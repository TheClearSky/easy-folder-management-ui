import type { FolderAccess } from '../core/backends';
import { formatBytes } from '../core/format';
import type { UnlinkPlan, UnlinkProgress } from '../core/fileLibrary';
import type { ConfirmRequest } from '../core/workspace';
import type { ChoiceProgress, ChoiceRequest } from './ChoiceDialog';

/**
 * The library's questions, worded for `useChoiceDialog().ask` — every one
 * says exactly what will happen (what is copied, how big it is, whether it
 * fits, what can be undone). All wording is overridable.
 *
 *     const dialog = useChoiceDialog();
 *     new Workspace({
 *       …,
 *       confirm: async (request) => (await dialog.ask(confirmChoice(request))) === 'confirm',
 *       chooseUnlink: (plan) => dialog.ask(unlinkChoice(plan)),
 *     });
 *     // Linking: ask first (a click on a choice is a fresh user gesture),
 *     // then open the picker with that mode.
 *     const access = await dialog.ask(accessChoice());
 *     if (access !== 'cancel') {
 *       const folder = await pickFolder({ access });
 *       if (folder) await workspace.link(folder, { access });
 *     }
 */

type LibraryDialogStrings = {
  accessTitle: string;
  accessBody: string;
  accessRead: string;
  accessReadHint: string;
  accessReadWrite: string;
  accessReadWriteHint: string;

  unlinkTitle(folderName: string): string;
  unlinkBody: string;
  keep: string;
  keepHint(plan: UnlinkPlan): string;
  keepTooBig(plan: UnlinkPlan): string;
  remove: string;
  removeHint: string;
  forgetTitle(folderName: string): string;
  forgetBody: string;
  forget: string;

  copyingTitle: string;
  copyingText(progress: UnlinkProgress): string;

  linkTitle(folderName: string): string;
  linkBody(request: Extract<ConfirmRequest, { kind: 'link' }>): string;
  link: string;

  deleteTitle(label: string): string;
  deleteBody(request: Extract<ConfirmRequest, { kind: 'delete' }>): string;
  delete: string;
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const DEFAULT_STRINGS: LibraryDialogStrings = {
  accessTitle: 'How should the app use the folder?',
  accessBody: 'You can change this later from the tag next to the folder name.',
  accessRead: 'Read only',
  accessReadHint: 'Browse and open files. Nothing in the folder is ever changed.',
  accessReadWrite: 'Read & write',
  accessReadWriteHint: 'Also create, rename, move and delete files and folders in it.',

  unlinkTitle: (name) => `Unlink “${name}”?`,
  unlinkBody: 'The folder and its files stay on your disk. Choose what this browser’s library keeps.',
  keep: 'Keep a copy in this browser',
  keepHint: (plan) => {
    const parts = [
      `Copies ${plural(plan.keep.files, 'file')} (${formatBytes(plan.keep.bytes)}) and ${plural(plan.keep.folders, 'folder')} into this browser’s storage`,
    ];
    if (plan.storage) parts[0] += ` — ${formatBytes(plan.storage.available)} free`;
    parts[0] += '.';
    const { leftOnDisk, unreadable } = plan.keep;
    if (leftOnDisk > 0) parts.push(`${plural(leftOnDisk, 'other file')} ${leftOnDisk === 1 ? 'stays' : 'stay'} on disk only.`);
    if (unreadable > 0) parts.push(`${plural(unreadable, 'file')} could not be read and will be skipped.`);
    return parts.join(' ');
  },
  keepTooBig: (plan) =>
    `Not enough space: needs ${formatBytes(plan.keep.bytes)}, ${formatBytes(plan.storage?.available ?? 0)} free.`,
  remove: 'Remove from the library',
  removeHint: 'This browser’s library becomes empty. Nothing is deleted from your disk.',
  forgetTitle: (name) => `Forget “${name}”?`,
  forgetBody:
    'The browser no longer has access to this folder, so nothing can be copied. The library becomes empty; nothing on your disk is touched.',
  forget: 'Forget',

  copyingTitle: 'Copying into this browser…',
  copyingText: (p) =>
    `${formatBytes(p.bytesCopied)} of ${formatBytes(p.bytesTotal)} · ${Math.min(p.filesCopied + (p.currentFile ? 1 : 0), p.filesTotal)} of ${p.filesTotal}${p.currentFile ? ` · ${p.currentFile}` : ''}`,

  linkTitle: (name) => `Link “${name}”?`,
  linkBody: (request) =>
    `The ${plural(request.openable, 'file')} and ${plural(request.folders, 'folder')} kept in this browser will be deleted from it, and the folder becomes the library.`,
  link: 'Link folder',

  deleteTitle: (label) => `Delete ${label}?`,
  deleteBody: (request) => {
    const parts = [request.onDisk ? 'It is deleted from your disk.' : 'It is deleted from this browser’s library.'];
    if (request.hidden > 0) parts.push(`${plural(request.hidden, 'hidden item')} inside (like .git) go too.`);
    const files = request.openable + request.otherFiles;
    if (request.permanent === 0) parts.push('You can undo this until the page is reloaded.');
    else if (request.permanent >= files) parts.push('This cannot be undone.');
    else parts.push(`${plural(request.permanent, 'file')} cannot be brought back with Undo.`);
    return parts.join(' ');
  },
  delete: 'Delete',
};

/** Link read-only or read & write. Resolves the `FolderAccess` (or
 *  `'cancel'`) — pass it to `pickFolder({ access })` and `link(…, { access })`. */
function accessChoice(
  options: { recommended?: FolderAccess; strings?: Partial<LibraryDialogStrings> } = {},
): ChoiceRequest<FolderAccess> {
  const s = { ...DEFAULT_STRINGS, ...options.strings };
  const recommended = options.recommended ?? 'read';
  return {
    title: s.accessTitle,
    body: s.accessBody,
    choices: [
      { id: 'read', label: s.accessRead, description: s.accessReadHint, tone: recommended === 'read' ? 'primary' : 'neutral' },
      {
        id: 'readwrite',
        label: s.accessReadWrite,
        description: s.accessReadWriteHint,
        tone: recommended === 'readwrite' ? 'primary' : 'neutral',
      },
    ],
  };
}

/** KEEP or REMOVE, with what KEEP copies, its size, the free space, and
 *  KEEP disabled when the browser says it will not fit. A folder awaiting
 *  reconnection only offers Forget (`'remove'`). */
function unlinkChoice(plan: UnlinkPlan, strings?: Partial<LibraryDialogStrings>): ChoiceRequest<'keep' | 'remove'> {
  const s = { ...DEFAULT_STRINGS, ...strings };
  if (plan.mode === 'forget') {
    return {
      title: s.forgetTitle(plan.folderName),
      body: s.forgetBody,
      choices: [{ id: 'remove', label: s.forget, tone: 'danger' }],
    };
  }
  const tooBig = plan.fits === false;
  return {
    title: s.unlinkTitle(plan.folderName),
    body: s.unlinkBody,
    choices: [
      {
        id: 'keep',
        label: s.keep,
        description: tooBig ? s.keepTooBig(plan) : s.keepHint(plan),
        tone: tooBig ? 'neutral' : 'primary',
        disabled: tooBig,
      },
      { id: 'remove', label: s.remove, description: s.removeHint },
    ],
  };
}

/** The progress view for a KEEP copy (`useChoiceDialog().showProgress`). */
function unlinkProgressView(
  progress: UnlinkProgress,
  onCancel?: () => void,
  strings?: Partial<LibraryDialogStrings>,
): ChoiceProgress {
  const s = { ...DEFAULT_STRINGS, ...strings };
  const value =
    progress.bytesTotal > 0
      ? progress.bytesCopied / progress.bytesTotal
      : progress.filesTotal > 0
        ? progress.filesCopied / progress.filesTotal
        : null;
  return { title: s.copyingTitle, value, text: s.copyingText(progress), onCancel };
}

/** The workspace's `confirm` requests (link over a non-empty library,
 *  delete). Resolves `'confirm'` or `'cancel'`. */
function confirmChoice(request: ConfirmRequest, strings?: Partial<LibraryDialogStrings>): ChoiceRequest<'confirm'> {
  const s = { ...DEFAULT_STRINGS, ...strings };
  if (request.kind === 'link') {
    return {
      title: s.linkTitle(request.folderName),
      body: s.linkBody(request),
      choices: [{ id: 'confirm', label: s.link, tone: 'danger' }],
    };
  }
  return {
    title: s.deleteTitle(request.label),
    body: s.deleteBody(request),
    choices: [{ id: 'confirm', label: s.delete, tone: 'danger' }],
  };
}

export { accessChoice, confirmChoice, unlinkChoice, unlinkProgressView };
export type { LibraryDialogStrings };
