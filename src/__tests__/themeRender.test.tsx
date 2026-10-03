// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { LibrarySnapshot } from '../core/fileLibrary';
import type { LibraryNode } from '../core/libraryTree';
import { extensionPolicy } from '../core/policy';
import {
  createToaster,
  EmptyState,
  FileSidebar,
  FolderThemeProvider,
  PanelErrorBoundary,
  RecentList,
  TabStrip,
  Toaster,
  useChoiceDialog,
  useFolderTheme,
  useUnsavedChangesDialog,
  WelcomeAction,
  WelcomeLayout,
  WelcomeSection,
} from '../ui';
import type { ChoiceProgress, ChoiceRequest, EfmTheme } from '../ui';

/**
 * Every slot of `EfmTheme`, by section. The mapped type makes this list
 * EXHAUSTIVE at compile time: a slot added to the types without a line here
 * fails `tsc`, and a line here without a slot does too.
 */
type SlotList = { [Section in keyof EfmTheme]-?: Record<keyof NonNullable<EfmTheme[Section]>, true> };
const ALL_SLOTS: SlotList = {
  menu: { content: true, item: true, hint: true, check: true, separator: true },
  fileSidebar: {
    root: true, header: true, title: true, toolbarButton: true, modeRow: true, modeLabel: true,
    reconnectButton: true, accessTag: true, accessTagReadOnly: true, accessTagReadWrite: true, accessMenu: true,
    accessMenuItem: true, selectionBar: true, savingLabel: true, tree: true, row: true, rowSelected: true,
    rowActive: true, rowFocused: true, rowDropTarget: true, rowInert: true, rowChevron: true, rowIcon: true,
    rowLabel: true, rowRenameInput: true, dirtyDot: true, empty: true, dropLine: true, contextMenu: true,
    contextMenuItem: true, notice: true, error: true,
  },
  tabStrip: {
    root: true, tablist: true, tab: true, tabActive: true, tabInactive: true, tabPreview: true, tabDragging: true,
    tabIcon: true, tabLabel: true, tabLabelPreview: true, tabLabelMissing: true, tabLabelError: true,
    closeButton: true, dirtyMark: true, dropIndicator: true, overflowButton: true, overflowMenu: true,
    overflowItem: true, overflowItemActive: true, tabMenu: true, tabMenuItem: true,
  },
  choiceDialog: {
    panel: true, title: true, body: true, button: true, actions: true, choice: true, choicePrimary: true,
    choiceDanger: true, choiceNeutral: true, cards: true, card: true, cardPrimary: true, cardDanger: true,
    cardNeutral: true, cardLabel: true, cardDescription: true, cancel: true, progressTrack: true,
    progressBar: true, progressText: true,
  },
  unsavedDialog: {
    panel: true, title: true, list: true, body: true, actions: true, button: true, discard: true, cancel: true,
    save: true,
  },
  toaster: { viewport: true, toast: true, message: true, action: true, close: true },
  welcome: {
    layout: true, content: true, title: true, grid: true, section: true, sectionTitle: true, action: true,
    actionLabel: true, actionHint: true, recentItem: true, recentEmpty: true,
  },
  emptyState: { root: true, icon: true, title: true, rows: true, row: true, rowButton: true, hint: true },
  panelError: { root: true, title: true, message: true, retryButton: true },
};

const marker = (section: string, slot: string) => `slot-${section}-${slot}`;
/** A theme whose every slot is a unique marker class. */
const MARKER_THEME = Object.fromEntries(
  Object.entries(ALL_SLOTS).map(([section, slots]) => [
    section,
    Object.fromEntries(Object.keys(slots).map((slot) => [slot, marker(section, slot)])),
  ]),
) as EfmTheme;

/** Slots whose state jsdom cannot produce (headless-tree's HTML5 drag). */
const NOT_RENDERED_IN_JSDOM = new Set(['fileSidebar.rowDropTarget']);

/** Every marker class present anywhere in the document, portals included. */
const found = new Set<string>();
function collect() {
  for (const element of document.body.querySelectorAll('[class]')) {
    for (const token of element.getAttribute('class')!.split(/\s+/)) if (token.startsWith('slot-')) found.add(token);
  }
}

const themed = (children: ReactNode) => <FolderThemeProvider theme={MARKER_THEME}>{children}</FolderThemeProvider>;

beforeAll(() => {
  // jsdom gaps the components touch: native <dialog> modality, Radix's
  // ResizeObserver, scrollIntoView.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  if (typeof window.PointerEvent === 'undefined') {
    // Radix and the tab drag read `button`, `pointerType`, `clientX`.
    class PointerEventShim extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? 'mouse';
      }
    }
    window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
  }
});

afterEach(() => cleanup());

// ── fixtures ──────────────────────────────────────────────────────────────
const node = (id: string, kind: LibraryNode['kind'], name: string, parentId: string | null): LibraryNode => ({
  id,
  kind,
  name,
  parentId,
});
const policy = extensionPolicy({ openable: ['.mkv'], content: 'binary' });

function snapshot(overrides: Partial<LibrarySnapshot> = {}, withFiles = true): LibrarySnapshot {
  const nodes: Record<string, LibraryNode> = { root: node('root', 'folder', '', null) };
  const children: Record<string, string[]> = { root: [] };
  if (withFiles) {
    nodes.shows = node('shows', 'folder', 'Shows', 'root');
    nodes.ep1 = node('ep1', 'file', 'ep1.mkv', 'shows');
    nodes.a = node('a', 'file', 'a.mkv', 'root');
    nodes.b = node('b', 'file', 'b.mkv', 'root');
    nodes.notes = node('notes', 'file', 'notes.txt', 'root');
    children.root = ['shows', 'a', 'b', 'notes'];
    children.shows = ['ep1'];
  }
  return {
    mode: { kind: 'memory' },
    tree: { rootId: 'root', nodes, children },
    unsupported: new Set(),
    error: null,
    notice: null,
    busy: false,
    undoableDelete: null,
    storageUnavailable: false,
    folderAccess: null,
    unlinkProgress: null,
    ...overrides,
  };
}

const sidebarProps = {
  policy,
  readOnly: false,
  canLinkFolders: true,
  onOpen: () => {},
};

// ── tests ─────────────────────────────────────────────────────────────────
describe('theme slots land on their elements', () => {
  it('FileSidebar: memory mode, rows in every state, the portaled context menu', () => {
    const { container } = render(
      themed(
        <FileSidebar
          {...sidebarProps}
          snapshot={snapshot({ busy: true, notice: 'heads up', error: 'oops', undoableDelete: 'x.mkv' })}
          activeFileId='a'
          isDirty={(id) => id === 'a'}
          onNewFile={() => {}}
          onNewFolder={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onUndoDelete={() => {}}
          onLink={() => {}}
          onDismissError={() => {}}
          onDismissNotice={() => {}}
          contextActions={() => [{ id: 'share', label: 'Share', shortcut: 'S', onSelect: () => {} }]}
        />,
      ),
    );
    collect();
    const row = [...container.querySelectorAll('[role=treeitem]')].find((element) => element.textContent?.includes('a.mkv'))!;
    expect(row.className).toContain(marker('fileSidebar', 'rowActive'));
    expect(row.className).toContain(marker('fileSidebar', 'rowSelected'));
    // The STATE slot comes after the base slot.
    expect(row.className.indexOf(marker('fileSidebar', 'row'))).toBeLessThan(
      row.className.indexOf(marker('fileSidebar', 'rowActive')),
    );

    fireEvent.contextMenu(row);
    const menu = document.querySelector('[data-efm=file-menu]')!;
    expect(menu).not.toBeNull();
    // Portaled OUT of the sidebar's DOM, yet the theme context reached it.
    expect(container.contains(menu)).toBe(false);
    expect(menu.className).toContain(marker('menu', 'content'));
    expect(menu.className).toContain(marker('fileSidebar', 'contextMenu'));
    collect();

    // A rename in progress (a double-click on a file renames by default). A
    // fresh mount: the open menu's focus trap would blur — and so end — it.
    cleanup();
    const renaming = render(themed(<FileSidebar {...sidebarProps} snapshot={snapshot()} activeFileId={null} onRename={() => {}} />));
    const fileRow = [...renaming.container.querySelectorAll('[role=treeitem]')].find((element) =>
      element.textContent?.includes('b.mkv'),
    )!;
    fireEvent.doubleClick(fileRow);
    expect(renaming.container.querySelector('input')?.className).toContain(marker('fileSidebar', 'rowRenameInput'));
    collect();
  });

  it('FileSidebar: folder mode access tag + its portaled menu, read-only tag, reconnect, empty', () => {
    const { container } = render(
      themed(
        <FileSidebar
          {...sidebarProps}
          snapshot={snapshot({ mode: { kind: 'folder', folderName: 'Movies' }, folderAccess: 'readwrite' })}
          activeFileId={null}
          onChangeAccess={() => {}}
          onUnlink={() => {}}
        />,
      ),
    );
    const tag = container.querySelector('[data-efm=access-tag]')!;
    expect(tag.className).toContain(marker('fileSidebar', 'accessTagReadWrite'));
    fireEvent.keyDown(tag, { key: 'Enter' });
    const menu = document.querySelector('[data-efm=access-menu]')!;
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    collect();
    cleanup();

    render(
      themed(
        <FileSidebar
          {...sidebarProps}
          snapshot={snapshot({ mode: { kind: 'folder', folderName: 'Movies' }, folderAccess: 'read' })}
          activeFileId={null}
        />,
      ),
    );
    expect(document.querySelector('[data-efm=access-tag]')!.className).toContain(marker('fileSidebar', 'accessTagReadOnly'));
    collect();
    cleanup();

    render(
      themed(
        <FileSidebar
          {...sidebarProps}
          snapshot={snapshot({ mode: { kind: 'reconnect', folderName: 'Movies' }, folderAccess: 'readwrite' }, false)}
          activeFileId={null}
          onReconnect={() => {}}
        />,
      ),
    );
    collect();
  });

  it('TabStrip: tab states, drag, the portaled tab menu and all-tabs menu', () => {
    const { container } = render(
      themed(
        <TabStrip
          order={['a', 'b', 'c']}
          active='a'
          preview='b'
          label={(id) => `${id}.txt`}
          isDirty={(id) => id === 'c'}
          status={(id) => (id === 'b' ? 'missing' : id === 'c' ? 'error' : 'ok')}
          renderIcon={() => '◇'}
          onActivate={() => {}}
          onClose={() => {}}
          onReorder={() => {}}
          onCloseOthers={() => {}}
          panelId='panel'
          strings={{ closeShortcut: 'Ctrl+W' }}
        />,
      ),
    );
    const tabs = container.querySelectorAll('[role=tab]');
    expect(tabs[0].className).toContain(marker('tabStrip', 'tabActive'));
    expect(tabs[0].className).not.toContain(marker('tabStrip', 'tabInactive'));
    expect(tabs[1].className).toContain(marker('tabStrip', 'tabInactive'));
    expect(tabs[1].className).toContain(marker('tabStrip', 'tabPreview'));
    collect();

    // Drag the first tab: dragging + the insertion line.
    fireEvent.pointerDown(tabs[0], { button: 0, clientX: 0, pointerType: 'mouse' });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 60 }));
    });
    collect();
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });

    fireEvent.contextMenu(tabs[0]);
    const tabMenu = document.querySelector('[data-efm=tab-menu]')!;
    expect(container.contains(tabMenu)).toBe(false);
    expect(tabMenu.className).toContain(marker('tabStrip', 'tabMenu'));
    collect();
    fireEvent.keyDown(tabMenu, { key: 'Escape' });

    fireEvent.keyDown(container.querySelector('[aria-label="All open tabs"]')!, { key: 'Enter' });
    const allTabs = document.querySelector('[data-efm=all-tabs-menu]')!;
    expect(container.contains(allTabs)).toBe(false);
    const items = allTabs.querySelectorAll('[role=menuitemradio]');
    expect(items[0].className).toContain(marker('tabStrip', 'overflowItemActive'));
    expect(items[1].className).toContain(marker('tabStrip', 'overflowItem'));
    collect();
  });

  it('ChoiceDialog: stacked cards, inline choices, progress — rendered where `element` is placed', async () => {
    let api: ReturnType<typeof useChoiceDialog> | null = null;
    function Harness() {
      const dialog = useChoiceDialog();
      api = dialog;
      return <>{dialog.element}</>;
    }
    render(themed(<Harness />));
    const stacked: ChoiceRequest = {
      title: 'Unlink?',
      body: 'Body',
      choices: [
        { id: 'keep', label: 'Keep', tone: 'primary', description: 'copy' },
        { id: 'remove', label: 'Remove', tone: 'danger', description: 'empty' },
        { id: 'other', label: 'Other', description: 'neutral' },
      ],
    };
    act(() => void api!.ask(stacked));
    expect(document.querySelector('dialog')!.className).toContain(marker('choiceDialog', 'panel'));
    collect();
    act(() => void api!.ask({ ...stacked, choices: stacked.choices.map(({ description: _drop, ...choice }) => choice) }));
    collect();
    const progress: ChoiceProgress = { title: 'Copying', body: 'Body', value: 0.5, text: '1 of 2', onCancel: () => {} };
    act(() => {
      fireEvent.click(document.querySelector('[data-choice=keep]')!);
      api!.showProgress(progress);
    });
    expect(document.querySelector('[role=progressbar]')!.className).toContain(marker('choiceDialog', 'progressTrack'));
    collect();
  });

  it('UnsavedChangesDialog, Toaster, Welcome, EmptyState, PanelErrorBoundary', () => {
    let ask: ((names: readonly string[]) => Promise<unknown>) | null = null;
    function Unsaved() {
      const dialog = useUnsavedChangesDialog();
      ask = dialog.ask;
      return <>{dialog.element}</>;
    }
    const store = createToaster();
    function Boom(): ReactNode {
      throw new Error('boom');
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      themed(
        <Toaster store={store}>
          <Unsaved />
          <WelcomeLayout title='Welcome'>
            <WelcomeSection title='Start'>
              <WelcomeAction hint='Ctrl+O' onClick={() => {}}>
                Open
              </WelcomeAction>
              <RecentList entries={[{ id: 'r', name: 'recent.mkv', detail: 'today' }]} onOpen={() => {}} />
              <RecentList entries={[]} onOpen={() => {}} />
            </WelcomeSection>
          </WelcomeLayout>
          <EmptyState icon='▶' rows={[{ label: 'Open', hint: 'click', onClick: () => {} }, { label: 'Static', hint: 'x' }]} />
          <PanelErrorBoundary onError={() => {}}>
            <Boom />
          </PanelErrorBoundary>
        </Toaster>,
      ),
    );
    act(() => {
      void ask!(['a.txt', 'b.txt']);
      store.show({ message: 'Saved', action: { label: 'Undo', run: () => {} } });
    });
    collect();
    error.mockRestore();
  });

  // Runs last: every slot the earlier renders could produce was seen.
  it('every slot of EfmTheme was rendered somewhere (portals included)', () => {
    const missing = Object.entries(ALL_SLOTS).flatMap(([section, slots]) =>
      Object.keys(slots)
        .filter((slot) => !NOT_RENDERED_IN_JSDOM.has(`${section}.${slot}`))
        .filter((slot) => !found.has(marker(section, slot)))
        .map((slot) => `${section}.${slot}`),
    );
    expect(missing).toEqual([]);
  });
});

describe('FolderThemeProvider', () => {
  it('without a provider (or with the default preset) the classes are the defaults', () => {
    const tabs = (
      <TabStrip order={['a']} active='a' label={(id) => id} onActivate={() => {}} onClose={() => {}} onReorder={() => {}} panelId='p' />
    );
    // Radix's generated ids differ per mount; everything else must be identical.
    const html = (element: HTMLElement) => element.innerHTML.replace(/id="radix-[^"]*"/g, '');
    const bare = html(render(tabs).container);
    cleanup();
    const withDefault = html(render(<FolderThemeProvider preset='default'>{tabs}</FolderThemeProvider>).container);
    expect(withDefault).toBe(bare);
    expect(bare).not.toContain('slot-');
  });

  it('memoises structurally: an equal inline theme keeps the context identity, a changed one does not', () => {
    const seen: (EfmTheme | undefined)[] = [];
    function Probe() {
      const theme = useFolderTheme();
      useEffect(() => {
        seen.push(theme);
      });
      return null;
    }
    const { rerender } = render(
      <FolderThemeProvider theme={{ menu: { item: 'a' } }}>
        <Probe />
      </FolderThemeProvider>,
    );
    rerender(
      <FolderThemeProvider theme={{ menu: { item: 'a' } }}>
        <Probe />
      </FolderThemeProvider>,
    );
    rerender(
      <FolderThemeProvider theme={{ menu: { item: 'b' } }}>
        <Probe />
      </FolderThemeProvider>,
    );
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[1]);
    expect(seen[2]?.menu?.item).toBe('b');
  });

  it('the innermost provider wins wholesale, and useFolderTheme is undefined outside any', () => {
    let inner: EfmTheme | undefined;
    let outside: EfmTheme | undefined = {};
    function Inner() {
      inner = useFolderTheme();
      return null;
    }
    function Outside() {
      outside = useFolderTheme();
      return null;
    }
    render(
      <>
        <Outside />
        <FolderThemeProvider theme={{ menu: { item: 'outer' }, toaster: { toast: 'outer' } }}>
          <FolderThemeProvider theme={{ menu: { item: 'inner' } }}>
            <Inner />
          </FolderThemeProvider>
        </FolderThemeProvider>
      </>,
    );
    expect(outside).toBeUndefined();
    expect(inner).toEqual({ menu: { item: 'inner' } });
  });

  it('an unprefixed slot class replaces the conflicting default on the element', () => {
    const { container } = render(
      <FolderThemeProvider theme={{ tabStrip: { root: 'bg-[#123] [--efm-accent:#e9d3a8]' } }}>
        <TabStrip order={['a']} active='a' label={(id) => id} onActivate={() => {}} onClose={() => {}} onReorder={() => {}} panelId='p' />
      </FolderThemeProvider>,
    );
    const root = container.querySelector('[data-efm=tab-strip]')!;
    const classes = root.className.split(' ');
    expect(classes).toContain('bg-[#123]');
    expect(classes).toContain('[--efm-accent:#e9d3a8]');
    expect(classes).not.toContain('efm:bg-surface');
    expect(classes).toContain('efm:border-b'); // non-conflicting defaults stay
  });
});
