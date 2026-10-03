import { useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useTree } from '@headless-tree/react';
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from '@headless-tree/core';
import type { DragTarget, ItemInstance, TreeInstance } from '@headless-tree/core';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { FolderAccess } from '../core/backends';
import type { LibrarySnapshot } from '../core/fileLibrary';
import type { LibraryNode } from '../core/libraryTree';
import { nameKey, splitExtension } from '../core/names';
import type { FilePolicy } from '../core/policy';
import { cn } from './cn';
import { useFolderTheme } from './theme/FolderThemeContext';

/**
 * The file library as a left sidebar: a headless-tree tree (MIT, zero
 * dependencies) whose rows are rendered here. Presentational: it shows a
 * `LibrarySnapshot` and reports what the user did; every handler that is
 * omitted hides its control (a read-only video library passes no
 * `onNewFile`/`onRename`/`onMove`/`onDelete`).
 *
 * Ported from Nodestra's `FileSidebar` with its fixes intact (ids in
 * brackets refer to that app's review/2026-09-26-library):
 * placeholder rows for stale ids, pruned tree state (H1), rebuild before
 * paint (H2), rename-box click isolation (G4), commit on blur without focus
 * theft (G3), modifier-click is selection not open (G5), keys outside the
 * tree pass through to the app (G1/G2), a file reaches the root by dropping
 * on a root file (S13), Backspace deletes on macOS (S20), a renamed file
 * keeps its required extension (I1).
 */

type FileSidebarStrings = {
  title: string;
  newFile: string;
  newFileTitle: string;
  newFolder: string;
  newFolderTitle: string;
  loading: string;
  inBrowser: string;
  inBrowserTitle: string;
  tabOnly: string;
  linkFolder: string;
  linkFolderTitle: string;
  linkUnavailable: string;
  linkUnavailableTitle: string;
  folderTitle: string;
  readOnlyFolderTitle: string;
  /** The access tag in folder mode. */
  readOnlyTag: string;
  readWriteTag: string;
  accessMenuTitle: string;
  readOnlyOption: string;
  readOnlyOptionHint: string;
  readWriteOption: string;
  readWriteOptionHint: string;
  /** Reconnect a read & write folder read-only instead. */
  reconnectReadOnly: string;
  reconnectReadOnlyTitle: string;
  unlink: string;
  unlinkTitle: string;
  reconnect: string;
  reconnectTitle: string;
  forget: string;
  forgetTitle: string;
  open: string;
  rename: string;
  renameTitle: string;
  delete: string;
  deleteMany(count: number): string;
  deleteTitle: string;
  undoDelete: string;
  saving: string;
  empty: string;
  emptyReconnect: string;
  inert: string;
  unsupported: string;
  unsaved: string;
  dismiss: string;
};

const DEFAULT_STRINGS: FileSidebarStrings = {
  title: 'Files',
  newFile: '＋ File',
  newFileTitle: 'New file',
  newFolder: '＋ Folder',
  newFolderTitle: 'New folder',
  loading: 'Loading…',
  inBrowser: 'In this browser',
  inBrowserTitle: 'Stored in this browser, not on disk',
  tabOnly: 'This tab only',
  linkFolder: 'Link folder…',
  linkFolderTitle: 'Use a folder on this computer',
  linkUnavailable: 'Folder linking unavailable',
  linkUnavailableTitle:
    'Linking a local folder needs Chrome, Edge or Opera on desktop — Firefox and Safari do not provide the File System Access API.',
  folderTitle: 'Every change is written to this folder',
  readOnlyFolderTitle: 'This folder is linked read-only',
  readOnlyTag: 'Read only',
  readWriteTag: 'Read & write',
  accessMenuTitle: 'Folder access — click to change',
  readOnlyOption: 'Read only',
  readOnlyOptionHint: 'Never change the folder',
  readWriteOption: 'Read & write',
  readWriteOptionHint: 'Create, rename, move, delete',
  reconnectReadOnly: 'Read only',
  reconnectReadOnlyTitle: 'Continue without write access (the browser asks only to read)',
  unlink: 'Unlink',
  unlinkTitle: 'Stop using the folder',
  reconnect: 'Reconnect',
  reconnectTitle: 'The browser needs your permission again to use this folder',
  forget: 'Forget',
  forgetTitle: 'Forget this folder',
  open: 'Open',
  rename: 'Rename',
  renameTitle: 'Rename (F2)',
  delete: 'Delete',
  deleteMany: (count) => `Delete ${count} items`,
  deleteTitle: 'Delete (Del)',
  undoDelete: 'Undo delete',
  saving: 'Saving…',
  empty: 'No files yet.',
  emptyReconnect: 'Reconnect to see the folder’s files.',
  inert: 'Not a file this app opens',
  unsupported: 'This file could not be opened',
  unsaved: 'Unsaved changes',
  dismiss: 'Dismiss',
};

type ContextAction = {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect(): void;
};

type FileSidebarProps = {
  snapshot: LibrarySnapshot;
  /** Which files open (others are inert) and the extension a rename keeps. */
  policy: Pick<FilePolicy, 'isOpenable' | 'defaultExtension'>;
  activeFileId: string | null;
  isDirty?(fileId: string): boolean;
  /** Tree changes are disabled (loading, awaiting reconnection, read-only). */
  readOnly: boolean;
  /** Link / Unlink / Reconnect are disabled. */
  folderActionsDisabled?: boolean;
  canLinkFolders: boolean;
  /** `preview` is true for a single click when `previewOnClick` is set. */
  onOpen(fileId: string, options: { preview: boolean }): void;
  /** Single click opens a PREVIEW tab; double click opens it for good. */
  previewOnClick?: boolean;
  /** What a double click on a file does. Default: `'rename'`, or `'open'`
   *  when `previewOnClick` is set (VS Code). */
  doubleClick?: 'rename' | 'open';
  onNewFile?(parentId: string): void;
  onNewFolder?(parentId: string): void;
  onRename?(id: string, name: string): void;
  onMove?(ids: string[], targetFolderId: string): void;
  onDelete?(ids: string[]): void;
  onUndoDelete?(): void;
  onLink?(): void;
  onUnlink?(): void;
  /** Reconnect with the folder's own access — or, from the "Read only"
   *  button shown next to Reconnect when the folder is read & write and
   *  `onChangeAccess` is given, with `'read'`. */
  onReconnect?(access?: FolderAccess): void;
  /** The linked folder's access, shown as a tag ("Read only" / "Read &
   *  write"). Default: `snapshot.folderAccess`. */
  access?: FolderAccess | null;
  /** Makes the tag a menu to switch access. Call the switch straight from
   *  this handler: an upgrade needs the click's user activation. */
  onChangeAccess?(access: FolderAccess): void;
  /** Show the access tag in folder mode (default true). */
  showAccessTag?: boolean;
  onDismissError?(): void;
  onDismissNotice?(): void;
  /** Id of an item to put into rename mode right after it appears. */
  renameRequest?: string | null;
  onRenameRequestHandled?(): void;
  /** Hide inert files instead of greying them. */
  hideInert?: boolean;
  renderIcon?(node: LibraryNode, state: { expanded: boolean; inert: boolean }): ReactNode;
  /** Extra content at the end of a row (a size, a "watched" mark…). */
  rowExtras?(node: LibraryNode): ReactNode;
  /** App commands for the right-click menu, given the selected ids. */
  contextActions?(selectedIds: readonly string[]): ContextAction[];
  strings?: Partial<FileSidebarStrings>;
  className?: string;
};

/** Larger on touch screens: 26 px rows are too small for a finger. */
const ROW_HEIGHT = 'efm:h-[26px] efm:pointer-coarse:h-[40px] efm:pointer-coarse:text-[15px]';
const INDENT_PX = 14;
const TOOLBAR_BUTTON =
  'efm:cursor-pointer efm:rounded efm:px-1.5 efm:py-0.5 efm:text-[12px] efm:text-fg efm:hover:bg-hover efm:disabled:cursor-default efm:disabled:opacity-40 efm:disabled:hover:bg-transparent efm:pointer-coarse:px-3 efm:pointer-coarse:py-2 efm:pointer-coarse:text-[14px]';
const MENU_ITEM =
  'efm:flex efm:cursor-pointer efm:items-center efm:justify-between efm:gap-6 efm:rounded efm:px-2 efm:py-1 efm:text-[12px] efm:text-fg efm:outline-none efm:select-none efm:data-[disabled]:cursor-default efm:data-[disabled]:opacity-40 efm:data-[highlighted]:bg-hover efm:pointer-coarse:py-2.5 efm:pointer-coarse:text-[14px]';
const ACCESS_TAG =
  'efm:flex-none efm:rounded-full efm:border efm:px-1.5 efm:text-[10px] efm:leading-[16px] efm:font-semibold efm:tracking-wide efm:whitespace-nowrap efm:uppercase efm:pointer-coarse:px-2.5 efm:pointer-coarse:py-1 efm:pointer-coarse:text-[12px]';

/**
 * Keys the TREE owns when a row has focus. Everything else — letters and
 * numbers, Escape, Ctrl+Z — passes through to the app. Stopping every keydown
 * made Nodestra deaf after a single click on a file, Esc included (G1/G2).
 */
const TREE_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Enter',
  'F2',
  'Delete',
  'Backspace',
]);

/** Stand-in for an id the current tree no longer has (see the loader). */
function missingNode(id: string): LibraryNode {
  return { id, kind: 'file', name: '', parentId: null };
}

/** The folder a new item or a drop lands in: the item itself if it is a
 *  folder, else its parent. */
function folderFor(node: LibraryNode | undefined, rootId: string): string {
  if (!node) return rootId;
  return node.kind === 'folder' ? node.id : (node.parentId ?? rootId);
}

/**
 * Bring headless-tree's own state in line with the current data: every id it
 * remembers must still exist. Stale selected/focused/renaming/expanded ids
 * made keyboard Delete do nothing, drags refuse to start and rows unreachable
 * with Tab after a delete, a link or a re-scan (H1).
 */
function pruneTreeState(tree: TreeInstance<LibraryNode>, nodes: Record<string, LibraryNode>) {
  const state = tree.getState();
  const selected = (state.selectedItems ?? []).filter((id) => nodes[id]);
  if (selected.length !== (state.selectedItems ?? []).length) tree.setSelectedItems(selected);
  if (state.focusedItem && !nodes[state.focusedItem]) {
    tree.applySubStateUpdate('focusedItem', null);
  }
  if (state.renamingItem && !nodes[state.renamingItem]) {
    tree.applySubStateUpdate('renamingItem', null);
  }
  const expanded = [...new Set((state.expandedItems ?? []).filter((id) => nodes[id]))];
  if (expanded.length !== (state.expandedItems ?? []).length) {
    tree.applySubStateUpdate('expandedItems', expanded);
  }
  const dataRef = tree.getDataRef<{ selectUpToAnchorId?: string | null }>();
  if (dataRef.current.selectUpToAnchorId && !nodes[dataRef.current.selectUpToAnchorId]) {
    dataRef.current.selectUpToAnchorId = null;
  }
}

function FileSidebar(props: FileSidebarProps) {
  const {
    snapshot,
    activeFileId,
    readOnly,
    canLinkFolders,
    onOpen,
    renameRequest = null,
  } = props;
  const strings = { ...DEFAULT_STRINGS, ...props.strings };
  const isDirty = props.isDirty ?? (() => false);
  const folderActionsDisabled = props.folderActionsDisabled ?? false;
  const doubleClick = props.doubleClick ?? (props.previewOnClick ? 'open' : 'rename');
  const canRenameAny = props.onRename !== undefined && !readOnly;
  const canDeleteAny = props.onDelete !== undefined && !readOnly;
  const canMoveAny = props.onMove !== undefined && !readOnly;
  const theme = useFolderTheme();
  const slots = theme?.fileSidebar;
  const menu = theme?.menu;
  const toolbarButton = cn(TOOLBAR_BUTTON, slots?.toolbarButton);
  const contextMenuItem = cn(MENU_ITEM, menu?.item, slots?.contextMenuItem);
  const menuHint = cn('efm:text-fg-muted', menu?.hint);

  const treeData = snapshot.tree;
  // The data loader is read lazily by the tree; refs keep it (and the
  // handlers) current without rebuilding the tree instance on every render.
  const dataRef = useRef(treeData);
  dataRef.current = treeData;
  const propsRef = useRef(props);
  propsRef.current = props;
  const flagsRef = useRef({ canRenameAny, canDeleteAny, canMoveAny });
  flagsRef.current = { canRenameAny, canDeleteAny, canMoveAny };
  /** The rename SESSION whose text selection has been set, so re-renders do
   *  not reselect. Reset whenever no rename is active (G6). */
  const renameSelectedFor = useRef<string | null>(null);
  /** A modifier was held on the click that triggered the primary action. */
  const modifierClickRef = useRef(false);

  const isInert = (node: LibraryNode) =>
    node.kind === 'file' && !propsRef.current.policy.isOpenable(node.name);

  /** A renamed openable file keeps the policy's extension: a `.json` graph
   *  that lost it would turn into an inert file nobody can rename back (I1). */
  const withExtension = (node: LibraryNode, typed: string) => {
    const extension = propsRef.current.policy.defaultExtension;
    if (node.kind !== 'file' || extension === undefined || !propsRef.current.policy.isOpenable(node.name)) {
      return typed;
    }
    return nameKey(typed).endsWith(nameKey(extension)) ? typed : `${typed}${extension}`;
  };

  const commitRename = (item: ItemInstance<LibraryNode>, value: string) => {
    const node = item.getItemData();
    if (!node || !dataRef.current.nodes[node.id]) return;
    let name = value.trim();
    if (name.length === 0 || name === node.name) return;
    name = withExtension(node, name);
    propsRef.current.onRename?.(node.id, name);
  };

  const tree = useTree<LibraryNode>({
    rootItemId: treeData.rootId,
    getItemName: (item) => item.getItemData()?.name ?? '',
    isItemFolder: (item) => item.getItemData()?.kind === 'folder',
    dataLoader: {
      // Never undefined: headless-tree can ask for ids from the previous
      // structure before the rebuild, and throws on undefined — which once
      // unmounted Nodestra entirely. A placeholder is filtered out at render.
      getItem: (id) => dataRef.current.nodes[id] ?? missingNode(id),
      getChildren: (id) =>
        (dataRef.current.children[id] ?? []).filter((child) => {
          const node = dataRef.current.nodes[child];
          return !(propsRef.current.hideInert && node && isInert(node));
        }),
    },
    indent: INDENT_PX,
    // Folders are sorted by name, so a drop position between two rows has no
    // meaning; every drop lands INSIDE a folder.
    canReorder: false,
    canDrag: (items) =>
      flagsRef.current.canMoveAny &&
      items.every((item) => {
        const node = dataRef.current.nodes[item.getId()];
        return node !== undefined && !isInert(node);
      }),
    // A folder takes the drop; a FILE hands it to its parent folder — which
    // is how a file reaches the ROOT, the rows there being files (S13).
    canDrop: (_items, target: DragTarget<LibraryNode>) =>
      flagsRef.current.canMoveAny && dataRef.current.nodes[target.item.getId()] !== undefined,
    onDrop: (items, target) => {
      const targetNode = dataRef.current.nodes[target.item.getId()];
      propsRef.current.onMove?.(
        items.map((item) => item.getId()).filter((id) => dataRef.current.nodes[id]),
        folderFor(targetNode, dataRef.current.rootId),
      );
    },
    // Firefox only starts an HTML5 drag if the dragstart sets some data.
    createForeignDragObject: (items) => ({
      format: 'text/plain',
      data: items.map((item) => item.getItemName()).join('\n'),
      effectAllowed: 'move',
    }),
    canRename: (item) => {
      const node = dataRef.current.nodes[item.getId()];
      return flagsRef.current.canRenameAny && node !== undefined && !isInert(node);
    },
    onRename: commitRename,
    onPrimaryAction: (item) => {
      // Ctrl/Shift/Cmd+click is multi-select, not "open" (G5).
      if (modifierClickRef.current) return;
      const node = dataRef.current.nodes[item.getId()];
      if (node && node.kind === 'file' && !isInert(node)) {
        propsRef.current.onOpen(node.id, { preview: propsRef.current.previewOnClick ?? false });
      }
    },
    hotkeys: {
      customOpen: {
        hotkey: 'Enter',
        isEnabled: (instance) => !instance.isRenamingItem(),
        handler: (_event, instance) => {
          const focused = instance.getFocusedItem();
          if (focused.isFolder()) {
            if (focused.isExpanded()) focused.collapse();
            else focused.expand();
            return;
          }
          // Enter opens for good — it is a deliberate choice, not browsing.
          const node = dataRef.current.nodes[focused.getId()];
          if (node && !isInert(node)) propsRef.current.onOpen(node.id, { preview: false });
        },
      },
      customDelete: {
        hotkey: 'Delete',
        isEnabled: (instance) => !instance.isRenamingItem(),
        handler: (_event, instance) => deleteFromKeyboard(instance),
      },
      // macOS has no Delete key on most keyboards (S20).
      customBackspace: {
        hotkey: 'Backspace',
        isEnabled: (instance) => !instance.isRenamingItem(),
        handler: (_event, instance) => deleteFromKeyboard(instance),
      },
    },
    features: [
      syncDataLoaderFeature,
      selectionFeature,
      hotkeysCoreFeature,
      dragAndDropFeature,
      renamingFeature,
    ],
  });

  function deleteFromKeyboard(instance: TreeInstance<LibraryNode>) {
    if (!flagsRef.current.canDeleteAny) return;
    const selected = instance
      .getSelectedItems()
      .map((item) => item.getId())
      .filter((id) => dataRef.current.nodes[id] && id !== dataRef.current.rootId);
    const focusedId = instance.getState().focusedItem;
    const ids =
      selected.length > 0
        ? selected
        : focusedId && dataRef.current.nodes[focusedId]
          ? [focusedId]
          : [];
    if (ids.length > 0) propsRef.current.onDelete?.(ids);
  }

  // Structure changed (ours or a re-scan): prune stale ids and let the tree
  // re-read — BEFORE paint, so the old rows never flash (H2).
  useLayoutEffect(() => {
    pruneTreeState(tree, treeData.nodes);
    tree.rebuildTree();
  }, [tree, treeData, props.hideInert]);

  // The open file is revealed and selected (S14). DOM focus is NOT moved:
  // taking it from the app would divert the next keypress into the tree.
  useEffect(() => {
    if (!activeFileId || !treeData.nodes[activeFileId]) return;
    let parent = treeData.nodes[activeFileId].parentId;
    while (parent && parent !== treeData.rootId) {
      tree.getItemInstance(parent).expand();
      parent = treeData.nodes[parent]?.parentId ?? null;
    }
    tree.setSelectedItems([activeFileId]);
    tree.applySubStateUpdate('focusedItem', activeFileId);
    void tree.getItemInstance(activeFileId).scrollTo({ block: 'nearest' }).catch(() => {});
  }, [activeFileId, tree, treeData]);

  // A freshly created item goes straight into rename mode, like an explorer.
  useEffect(() => {
    if (!renameRequest) return;
    if (!treeData.nodes[renameRequest]) return;
    let parent = treeData.nodes[renameRequest].parentId;
    while (parent && parent !== treeData.rootId) {
      tree.getItemInstance(parent).expand();
      parent = treeData.nodes[parent]?.parentId ?? null;
    }
    tree.rebuildTree();
    const item = tree.getItemInstance(renameRequest);
    item.setFocused();
    tree.setSelectedItems([renameRequest]);
    item.startRenaming();
    propsRef.current.onRenameRequestHandled?.();
  }, [renameRequest, treeData, tree]);

  if (!tree.getState().renamingItem) renameSelectedFor.current = null;

  const focusedNode = (() => {
    const focused = tree.getState().focusedItem;
    return focused ? treeData.nodes[focused] : undefined;
  })();
  const targetFolder = folderFor(focusedNode, treeData.rootId);
  const selectedIds = tree
    .getSelectedItems()
    .map((item) => item.getId())
    .filter((id) => id !== treeData.rootId && treeData.nodes[id]);
  const singleSelected = selectedIds.length === 1 ? treeData.nodes[selectedIds[0]] : undefined;
  const renameTarget = canRenameAny && singleSelected && !isInert(singleSelected) ? singleSelected.id : null;
  const openTarget = singleSelected && singleSelected.kind === 'file' && !isInert(singleSelected) ? singleSelected.id : null;
  const appActions = props.contextActions?.(selectedIds) ?? [];
  const hasMenu = openTarget !== null || renameTarget !== null || (canDeleteAny && selectedIds.length > 0) || appActions.length > 0;

  const mode = snapshot.mode;
  const access = props.access === undefined ? snapshot.folderAccess : props.access;
  const showAccessTag = props.showAccessTag !== false && access !== null && access !== undefined;
  const accessLabel = access === 'readwrite' ? strings.readWriteTag : strings.readOnlyTag;
  const accessTone =
    access === 'readwrite' ? 'efm:border-accent efm:text-accent' : 'efm:border-fg-muted/60 efm:text-fg-muted';
  const accessTagSlots = cn(
    slots?.accessTag,
    access === 'readwrite' ? slots?.accessTagReadWrite : slots?.accessTagReadOnly,
  );
  const accessTag = showAccessTag ? (
    props.onChangeAccess ? (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          data-efm='access-tag'
          className={cn(
            ACCESS_TAG,
            accessTone,
            'efm:cursor-pointer efm:outline-none efm:hover:bg-hover efm:focus-visible:shadow-[0_0_0_1px_var(--efm-focus,var(--efm-accent))] efm:disabled:cursor-default efm:disabled:opacity-40',
            accessTagSlots,
          )}
          disabled={folderActionsDisabled}
          title={strings.accessMenuTitle}
          aria-label={`${accessLabel} — ${strings.accessMenuTitle}`}
        >
          {accessLabel} ▾
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align='end'
            data-efm='access-menu'
            className={cn(
              'efm:z-1100 efm:min-w-[220px] efm:rounded-md efm:border efm:border-border efm:bg-surface-raised efm:p-1 efm:shadow-xl',
              menu?.content,
              slots?.accessMenu,
            )}
          >
            <DropdownMenu.RadioGroup
              value={access ?? 'read'}
              onValueChange={(value) => {
                if (value !== access) props.onChangeAccess?.(value as FolderAccess);
              }}
            >
              {(['read', 'readwrite'] as const).map((option) => (
                <DropdownMenu.RadioItem key={option} value={option} className={cn(MENU_ITEM, 'efm:justify-start efm:gap-2', menu?.item, slots?.accessMenuItem)}>
                  <span aria-hidden='true' className={cn('efm:w-3 efm:text-accent', menu?.check)}>
                    {access === option ? '✓' : ''}
                  </span>
                  <span className='efm:flex efm:flex-col'>
                    <span>{option === 'read' ? strings.readOnlyOption : strings.readWriteOption}</span>
                    <span className={cn('efm:text-[11px] efm:text-fg-muted efm:pointer-coarse:text-[13px]', menu?.hint)}>
                      {option === 'read' ? strings.readOnlyOptionHint : strings.readWriteOptionHint}
                    </span>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    ) : (
      <span data-efm='access-tag' className={cn(ACCESS_TAG, accessTone, accessTagSlots)}>
        {accessLabel}
      </span>
    )
  ) : null;
  const visibleRootChildren = (treeData.children[treeData.rootId] ?? []).filter((id) => {
    const node = treeData.nodes[id];
    return node && !(props.hideInert && isInert(node));
  });
  const empty = visibleRootChildren.length === 0;
  const showToolbar = props.onNewFile !== undefined || props.onNewFolder !== undefined;
  const showSelectionBar = props.onRename !== undefined || props.onDelete !== undefined;

  return (
    <aside
      data-efm='file-sidebar'
      className={cn(
        'efm:flex efm:h-full efm:w-[260px] efm:flex-none efm:flex-col efm:border-r efm:border-border efm:bg-surface efm:text-[13px] efm:text-fg',
        slots?.root,
        props.className,
      )}
      aria-label={strings.title}
      onKeyDown={(event: ReactKeyboardEvent) => {
        const target = event.target as HTMLElement;
        // Typing in the rename box: every key belongs to the box, EXCEPT
        // Escape, which ends the rename (headless-tree handles it first).
        if (target.tagName === 'INPUT') {
          if (event.key !== 'Escape') event.stopPropagation();
          return;
        }
        // On a row: only the keys the tree uses (plus Ctrl+A select-all).
        if (
          target.getAttribute('role') === 'treeitem' &&
          (TREE_KEYS.has(event.key) || ((event.ctrlKey || event.metaKey) && event.key === 'a'))
        ) {
          event.stopPropagation();
        }
      }}
    >
      <div className={cn('efm:flex efm:items-center efm:gap-1 efm:border-b efm:border-border efm:px-2 efm:py-1.5', slots?.header)}>
        <span
          className={cn(
            'efm:mr-auto efm:text-[12px] efm:font-semibold efm:tracking-wide efm:text-fg-muted efm:uppercase',
            slots?.title,
          )}
        >
          {strings.title}
        </span>
        {showToolbar && props.onNewFile && (
          <button
            type='button'
            className={toolbarButton}
            disabled={readOnly}
            title={strings.newFileTitle}
            aria-label={strings.newFileTitle}
            onClick={() => props.onNewFile?.(targetFolder)}
          >
            {strings.newFile}
          </button>
        )}
        {showToolbar && props.onNewFolder && (
          <button
            type='button'
            className={toolbarButton}
            disabled={readOnly}
            title={strings.newFolderTitle}
            aria-label={strings.newFolderTitle}
            onClick={() => props.onNewFolder?.(targetFolder)}
          >
            {strings.newFolder}
          </button>
        )}
      </div>

      <div
        className={cn(
          'efm:flex efm:items-center efm:gap-1 efm:border-b efm:border-border efm:px-2 efm:py-1 efm:text-[12px] efm:text-fg-muted',
          slots?.modeRow,
        )}
      >
        {mode.kind === 'loading' && <span className={slots?.modeLabel}>{strings.loading}</span>}
        {mode.kind === 'memory' && (
          <>
            <span className={cn('efm:mr-auto', slots?.modeLabel)} title={strings.inBrowserTitle}>
              {snapshot.storageUnavailable ? strings.tabOnly : strings.inBrowser}
            </span>
            {props.onLink &&
              (canLinkFolders ? (
                <button
                  type='button'
                  className={toolbarButton}
                  disabled={folderActionsDisabled}
                  onClick={props.onLink}
                  title={strings.linkFolderTitle}
                >
                  {strings.linkFolder}
                </button>
              ) : (
                <span className={cn('efm:text-[11px]', slots?.modeLabel)} title={strings.linkUnavailableTitle}>
                  {strings.linkUnavailable}
                </span>
              ))}
          </>
        )}
        {mode.kind === 'folder' && (
          <>
            <span
              className={cn('efm:mr-auto efm:min-w-0 efm:truncate', slots?.modeLabel)}
              title={access === 'read' || readOnly ? strings.readOnlyFolderTitle : strings.folderTitle}
            >
              📁 {mode.folderName}
            </span>
            {accessTag}
            {props.onUnlink && (
              <button
                type='button'
                className={toolbarButton}
                disabled={folderActionsDisabled}
                onClick={props.onUnlink}
                title={strings.unlinkTitle}
              >
                {strings.unlink}
              </button>
            )}
          </>
        )}
        {mode.kind === 'reconnect' && (
          <>
            <span className={cn('efm:mr-auto efm:min-w-0 efm:truncate', slots?.modeLabel)}>📁 {mode.folderName}</span>
            {props.onReconnect && (
              <button
                type='button'
                className={cn(TOOLBAR_BUTTON, 'efm:text-warning', slots?.toolbarButton, slots?.reconnectButton)}
                disabled={folderActionsDisabled}
                onClick={() => props.onReconnect?.()}
                title={
                  access && showAccessTag
                    ? `${strings.reconnectTitle} (${access === 'readwrite' ? strings.readWriteTag : strings.readOnlyTag})`
                    : strings.reconnectTitle
                }
              >
                {strings.reconnect}
              </button>
            )}
            {props.onReconnect && props.onChangeAccess && showAccessTag && access === 'readwrite' && (
              <button
                type='button'
                className={toolbarButton}
                disabled={folderActionsDisabled}
                onClick={() => props.onReconnect?.('read')}
                title={strings.reconnectReadOnlyTitle}
              >
                {strings.reconnectReadOnly}
              </button>
            )}
            {props.onUnlink && (
              <button
                type='button'
                className={toolbarButton}
                disabled={folderActionsDisabled}
                onClick={props.onUnlink}
                title={strings.forgetTitle}
              >
                {strings.forget}
              </button>
            )}
          </>
        )}
      </div>

      {showSelectionBar && (
        <div className={cn('efm:flex efm:items-center efm:gap-1 efm:border-b efm:border-border efm:px-2 efm:py-1', slots?.selectionBar)}>
          {props.onRename && (
            <button
              type='button'
              className={toolbarButton}
              disabled={renameTarget === null}
              onClick={() => renameTarget && tree.getItemInstance(renameTarget).startRenaming()}
              title={strings.renameTitle}
            >
              {strings.rename}
            </button>
          )}
          {props.onDelete && (
            <button
              type='button'
              className={toolbarButton}
              disabled={!canDeleteAny || selectedIds.length === 0}
              onClick={() => props.onDelete?.(selectedIds)}
              title={strings.deleteTitle}
            >
              {strings.delete}
            </button>
          )}
          {snapshot.undoableDelete && props.onUndoDelete && (
            <button
              type='button'
              className={cn(TOOLBAR_BUTTON, 'efm:ml-auto', slots?.toolbarButton)}
              disabled={readOnly}
              onClick={props.onUndoDelete}
              title={`Restore ${snapshot.undoableDelete}`}
            >
              {strings.undoDelete}
            </button>
          )}
          {snapshot.busy && (
            <span className={cn('efm:ml-auto efm:text-[11px] efm:text-fg-muted', slots?.savingLabel)}>{strings.saving}</span>
          )}
        </div>
      )}

      <ContextMenu.Root>
        <ContextMenu.Trigger asChild disabled={!hasMenu}>
          <div
            {...tree.getContainerProps(strings.title)}
            className={cn('efm:relative efm:min-h-0 efm:flex-1 efm:overflow-y-auto efm:py-1 efm:outline-none', slots?.tree)}
          >
            {tree.getItems().map((item) => {
              // Skip stale rows (a placeholder from the loader) until the rebuild.
              const node = treeData.nodes[item.getId()];
              if (!node) return null;
              const inert = isInert(node);
              const isActive = node.id === activeFileId;
              const unsupported = snapshot.unsupported.has(node.id);
              const level = item.getItemMeta().level;
              const renameProps = item.isRenaming() ? item.getRenameInputProps() : null;
              const rowProps = item.getProps();
              const selected = item.isSelected();
              const focused = item.isFocused();
              const dropTarget = item.isDragTarget() && node.kind === 'folder';
              return (
                <div
                  key={item.getKey()}
                  {...rowProps}
                  onClick={(event) => {
                    modifierClickRef.current = event.ctrlKey || event.shiftKey || event.metaKey;
                    try {
                      rowProps.onClick?.(event);
                    } finally {
                      modifierClickRef.current = false;
                    }
                  }}
                  onDoubleClick={() => {
                    if (inert || node.kind !== 'file') return;
                    if (doubleClick === 'open') onOpen(node.id, { preview: false });
                    else if (flagsRef.current.canRenameAny) item.startRenaming();
                  }}
                  onContextMenu={() => {
                    // Right-clicking outside the selection acts on that row
                    // alone; inside a multi-selection it keeps the selection.
                    // The event then bubbles to the menu's trigger.
                    if (!item.isSelected()) {
                      tree.setSelectedItems([node.id]);
                      item.setFocused();
                    }
                  }}
                  className={cn(
                    'efm:flex efm:cursor-pointer efm:items-center efm:gap-1.5 efm:pr-2 efm:outline-none efm:select-none',
                    ROW_HEIGHT,
                    selected && 'efm:bg-hover',
                    isActive && 'efm:bg-[color:var(--efm-selection,color-mix(in_oklab,var(--efm-accent)_25%,transparent))]',
                    focused && 'efm:shadow-[inset_0_0_0_1px_var(--efm-focus,var(--efm-fg-disabled))]',
                    dropTarget && 'efm:bg-accent/40',
                    inert && 'efm:cursor-default efm:text-fg-disabled efm:opacity-60',
                    slots?.row,
                    selected && slots?.rowSelected,
                    isActive && slots?.rowActive,
                    focused && slots?.rowFocused,
                    dropTarget && slots?.rowDropTarget,
                    inert && slots?.rowInert,
                  )}
                  style={{ paddingLeft: 8 + level * INDENT_PX }}
                  title={inert ? strings.inert : unsupported ? strings.unsupported : undefined}
                >
                  <span aria-hidden='true' className={cn('efm:w-3 efm:text-center efm:text-[10px] efm:text-fg-muted', slots?.rowChevron)}>
                    {node.kind === 'folder' ? (item.isExpanded() ? '▾' : '▸') : ''}
                  </span>
                  <span aria-hidden='true' className={cn('efm:flex efm:w-4 efm:justify-center efm:text-[12px]', slots?.rowIcon)}>
                    {props.renderIcon
                      ? props.renderIcon(node, { expanded: item.isExpanded(), inert })
                      : node.kind === 'folder'
                        ? '🗀'
                        : inert
                          ? '·'
                          : '◇'}
                  </span>
                  {renameProps ? (
                    <input
                      {...renameProps}
                      ref={(element) => {
                        renameProps.ref?.(element);
                        // Select the NAME, not the extension — typing replaces
                        // "kick" and keeps ".json". Once per rename session.
                        if (element && renameSelectedFor.current !== node.id) {
                          renameSelectedFor.current = node.id;
                          const { stem } = splitExtension(node.name);
                          element.setSelectionRange(0, node.kind === 'file' ? stem.length : node.name.length);
                        }
                      }}
                      // The box lives inside the row; without these a click in
                      // it runs the ROW's click — toggling a folder or opening
                      // another file mid-rename (G4).
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      // Clicking away COMMITS (every explorer does), and without
                      // headless-tree's completeRenaming: that pulls DOM focus
                      // back onto the row ~20 ms later, stealing it from what
                      // the user just clicked (G3).
                      onBlur={() => {
                        const renaming = tree.getRenamingItem();
                        const value = tree.getRenamingValue();
                        renameSelectedFor.current = null;
                        tree.applySubStateUpdate('renamingItem', null);
                        if (renaming) commitRename(renaming, value);
                      }}
                      aria-label={`${strings.rename} ${node.name}`}
                      className={cn(
                        'efm:min-w-0 efm:flex-1 efm:rounded efm:border efm:border-accent efm:bg-surface-sunken efm:px-1 efm:text-[13px] efm:text-fg efm:outline-none',
                        slots?.rowRenameInput,
                      )}
                    />
                  ) : (
                    <span
                      className={cn(
                        'efm:min-w-0 efm:flex-1 efm:truncate',
                        unsupported && 'efm:line-through efm:decoration-fg-disabled',
                        slots?.rowLabel,
                      )}
                    >
                      {node.name}
                    </span>
                  )}
                  {props.rowExtras?.(node)}
                  {node.kind === 'file' && isDirty(node.id) && (
                    <span
                      aria-label={strings.unsaved}
                      title={strings.unsaved}
                      className={cn('efm:h-2 efm:w-2 efm:flex-none efm:rounded-full efm:bg-warning', slots?.dirtyDot)}
                    />
                  )}
                </div>
              );
            })}
            {empty && mode.kind !== 'loading' && (
              <p className={cn('efm:px-3 efm:py-4 efm:text-[12px] efm:leading-relaxed efm:text-fg-muted', slots?.empty)}>
                {mode.kind === 'reconnect' ? strings.emptyReconnect : strings.empty}
              </p>
            )}
            <div style={tree.getDragLineStyle()} className={cn('efm:pointer-events-none efm:h-0.5 efm:bg-accent', slots?.dropLine)} />
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            data-efm='file-menu'
            className={cn(
              'efm:z-1100 efm:min-w-[200px] efm:rounded-md efm:border efm:border-border efm:bg-surface-raised efm:p-1 efm:shadow-xl',
              menu?.content,
              slots?.contextMenu,
            )}
          >
            {openTarget !== null && (
              <ContextMenu.Item className={contextMenuItem} onSelect={() => onOpen(openTarget, { preview: false })}>
                {strings.open}
              </ContextMenu.Item>
            )}
            {renameTarget !== null && (
              <ContextMenu.Item
                className={contextMenuItem}
                onSelect={() => tree.getItemInstance(renameTarget).startRenaming()}
              >
                {strings.rename} <span className={menuHint}>F2</span>
              </ContextMenu.Item>
            )}
            {canDeleteAny && selectedIds.length > 0 && (
              <ContextMenu.Item className={contextMenuItem} onSelect={() => props.onDelete?.(selectedIds)}>
                {selectedIds.length > 1 ? strings.deleteMany(selectedIds.length) : strings.delete}{' '}
                <span className={menuHint}>Del</span>
              </ContextMenu.Item>
            )}
            {appActions.length > 0 && (openTarget !== null || renameTarget !== null || canDeleteAny) && (
              <ContextMenu.Separator className={cn('efm:my-1 efm:h-px efm:bg-border', menu?.separator)} />
            )}
            {appActions.map((action) => (
              <ContextMenu.Item
                key={action.id}
                className={contextMenuItem}
                disabled={action.disabled}
                onSelect={action.onSelect}
              >
                {action.label}
                {action.shortcut && <span className={menuHint}>{action.shortcut}</span>}
              </ContextMenu.Item>
            ))}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {snapshot.notice && (
        <div
          role='status'
          className={cn(
            'efm:flex efm:items-start efm:gap-2 efm:border-t efm:border-warning/50 efm:bg-warning/10 efm:px-2 efm:py-1.5 efm:text-[12px]',
            slots?.notice,
          )}
        >
          <span className='efm:min-w-0 efm:flex-1'>{snapshot.notice}</span>
          {props.onDismissNotice && (
            <button type='button' className={toolbarButton} onClick={props.onDismissNotice} aria-label={strings.dismiss}>
              ✕
            </button>
          )}
        </div>
      )}
      {snapshot.error && (
        <div
          role='alert'
          className={cn(
            'efm:flex efm:items-start efm:gap-2 efm:border-t efm:border-danger/60 efm:bg-danger/15 efm:px-2 efm:py-1.5 efm:text-[12px]',
            slots?.error,
          )}
        >
          <span className='efm:min-w-0 efm:flex-1'>{snapshot.error}</span>
          {props.onDismissError && (
            <button type='button' className={toolbarButton} onClick={props.onDismissError} aria-label={strings.dismiss}>
              ✕
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

export { FileSidebar };
export type { ContextAction, FileSidebarProps, FileSidebarStrings };
