import { useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from './cn';
import { useFolderTheme } from './theme/FolderThemeContext';

/**
 * The open tabs, VS Code style: one row; the app decides what each tab shows.
 * Presentational — it renders what it is given and reports what the user did
 * (the workspace or the app owns the tabs state).
 *
 * Keyboard follows the WAI-ARIA tabs pattern with MANUAL activation, because
 * activating a tab may swap a whole editor:
 *   ←/→ Home/End move focus · Enter/Space open · Delete closes ·
 *   Ctrl+Shift+←/→ move the tab · Shift+F10 / Menu key: the context menu.
 * Mouse: click opens, double-click keeps a preview tab, middle-click closes,
 * drag reorders.
 * Touch: tap opens; a swipe SCROLLS the strip (it never starts a drag, which
 * used to hijack the swipe); long-press opens the menu, whose Move Left /
 * Move Right reorder. Touch screens get larger targets (`pointer-coarse`).
 *
 * The close "✕" is mouse-only (`aria-hidden`, out of the tab order): an
 * interactive control nested in a `role=tab` is invalid ARIA, and keyboard
 * users close with Delete, which each tab announces via `aria-keyshortcuts`.
 */

type TabStatus = 'ok' | 'missing' | 'ended' | 'loading' | 'error';

type TabStripStrings = {
  tablist: string;
  allTabs: string;
  close: string;
  closeOthers: string;
  closeRight: string;
  closeSaved: string;
  closeAll: string;
  reopen: string;
  moveLeft: string;
  moveRight: string;
  unsaved: string;
  status: Record<Exclude<TabStatus, 'ok'>, string>;
  /** Shortcut hints shown in the menu; `''` hides one. */
  closeShortcut: string;
  reopenShortcut: string;
};

const DEFAULT_STRINGS: TabStripStrings = {
  tablist: 'Open tabs',
  allTabs: 'All open tabs',
  close: 'Close',
  closeOthers: 'Close Others',
  closeRight: 'Close to the Right',
  closeSaved: 'Close Saved',
  closeAll: 'Close All',
  reopen: 'Reopen Closed Tab',
  moveLeft: 'Move Left',
  moveRight: 'Move Right',
  unsaved: 'unsaved',
  status: { missing: 'deleted', ended: 'ended', loading: 'loading', error: 'error' },
  closeShortcut: '',
  reopenShortcut: '',
};

type TabStripProps = {
  order: readonly string[];
  active: string | null;
  /** The preview tab (italic; replaced by the next preview open). */
  preview?: string | null;
  label(id: string): string;
  isDirty?(id: string): boolean;
  status?(id: string): TabStatus;
  /** Shown before the label (a file-type icon, a 📡 marker…). */
  renderIcon?(id: string): ReactNode;
  /** Shown after the label (a live badge…). */
  renderBadge?(id: string): ReactNode;
  onActivate(id: string): void;
  onClose(ids: readonly string[]): void;
  onReorder(id: string, toIndex: number): void;
  /** Double-click: make the preview tab permanent. */
  onPromote?(id: string): void;
  /** Menu commands; each is hidden when its handler is omitted. */
  onCloseOthers?(id: string): void;
  onCloseRight?(id: string): void;
  onCloseSaved?(): void;
  onCloseAll?(): void;
  onReopen?(): void;
  /** id of the element the tabs control (the content area). */
  panelId: string;
  strings?: Partial<TabStripStrings>;
  className?: string;
};

const DRAG_THRESHOLD_PX = 4;
const EDGE_SCROLL_PX = 32;

const MENU_CONTENT =
  'efm:z-1100 efm:min-w-[200px] efm:rounded-md efm:border efm:border-border efm:bg-surface-raised efm:p-1 efm:shadow-xl';
const MENU_ITEM =
  'efm:flex efm:cursor-pointer efm:items-center efm:justify-between efm:gap-6 efm:rounded efm:px-2 efm:py-1 efm:text-[12px] efm:text-fg efm:outline-none efm:select-none efm:data-[disabled]:cursor-default efm:data-[disabled]:opacity-40 efm:data-[highlighted]:bg-hover efm:pointer-coarse:py-2.5 efm:pointer-coarse:text-[14px]';

function TabStrip(props: TabStripProps) {
  const { order, active, label, onActivate, onClose, onReorder, panelId } = props;
  const strings = { ...DEFAULT_STRINGS, ...props.strings };
  const isDirty = props.isDirty ?? (() => false);
  const status = props.status ?? (() => 'ok' as const);
  const theme = useFolderTheme();
  const slots = theme?.tabStrip;
  const menu = theme?.menu;
  const tabMenuItem = cn(MENU_ITEM, menu?.item, slots?.tabMenuItem);
  const menuHint = cn('efm:text-fg-muted', menu?.hint);
  const menuSeparator = cn('efm:my-1 efm:h-px efm:bg-border', menu?.separator);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const [focusId, setFocusId] = useState<string | null>(active);
  const [drag, setDrag] = useState<{
    id: string;
    startX: number;
    moving: boolean;
    dropIndex: number;
  } | null>(null);

  // The roving tab stop follows the active tab when focus is not in the strip.
  useEffect(() => {
    if (!scrollerRef.current?.contains(document.activeElement)) setFocusId(active);
  }, [active]);

  // Keep the active tab in view.
  useEffect(() => {
    if (active) tabRefs.current.get(active)?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [active, order]);

  const tabStop = focusId !== null && order.includes(focusId) ? focusId : (active ?? order[0] ?? null);

  const focusTab = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    tabRefs.current.get(id)?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent, id: string) => {
    const index = order.indexOf(id);
    if (event.ctrlKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      onReorder(id, index + (event.key === 'ArrowLeft' ? -1 : 1));
      requestAnimationFrame(() => tabRefs.current.get(id)?.focus());
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(order[(index - 1 + order.length) % order.length]);
        break;
      case 'ArrowRight':
        event.preventDefault();
        focusTab(order[(index + 1) % order.length]);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(order[0]);
        break;
      case 'End':
        event.preventDefault();
        focusTab(order[order.length - 1]);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        onActivate(id);
        break;
      case 'Delete':
        event.preventDefault();
        onClose([id]);
        focusTab(order[index + 1] ?? order[index - 1]);
        break;
    }
  };

  // ── drag reorder (one row, pointer events) ──────────────────────────
  const dropIndexAt = (clientX: number, draggedId: string) => {
    const others = order.filter((id) => id !== draggedId);
    let index = 0;
    for (const id of others) {
      const rect = tabRefs.current.get(id)?.getBoundingClientRect();
      if (rect && clientX > rect.left + rect.width / 2) index += 1;
    }
    return index;
  };
  const onPointerDown = (event: ReactPointerEvent, id: string) => {
    // A finger on the strip means "scroll": never start a drag from touch.
    if (event.button !== 0 || event.pointerType === 'touch') return;
    setDrag({ id, startX: event.clientX, moving: false, dropIndex: order.indexOf(id) });
  };
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      const moving = drag.moving || Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX;
      if (!moving) return;
      const scroller = scrollerRef.current;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (event.clientX < rect.left + EDGE_SCROLL_PX) scroller.scrollLeft -= 12;
        else if (event.clientX > rect.right - EDGE_SCROLL_PX) scroller.scrollLeft += 12;
      }
      setDrag({ ...drag, moving: true, dropIndex: dropIndexAt(event.clientX, drag.id) });
    };
    const onUp = () => {
      if (drag.moving) onReorder(drag.id, drag.dropIndex);
      setDrag(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  });

  if (order.length === 0) return null;
  const dragging = drag?.moving ? drag : null;
  const indicatorBefore = dragging ? order.filter((id) => id !== dragging.id)[dragging.dropIndex] : undefined;
  const indicatorAtEnd = dragging !== null && indicatorBefore === undefined;

  const describe = (id: string) => {
    const tabStatus = status(id);
    return [
      label(id),
      isDirty(id) ? strings.unsaved : null,
      tabStatus !== 'ok' ? strings.status[tabStatus] : null,
    ]
      .filter(Boolean)
      .join(', ');
  };

  return (
    <div
      data-efm='tab-strip'
      className={cn(
        'efm:flex efm:h-[34px] efm:flex-none efm:items-stretch efm:border-b efm:border-border efm:bg-surface efm:pointer-coarse:h-[42px]',
        slots?.root,
        props.className,
      )}
    >
      <div
        ref={scrollerRef}
        role='tablist'
        aria-label={strings.tablist}
        onWheel={(event) => {
          if (event.deltaY !== 0 && scrollerRef.current) scrollerRef.current.scrollLeft += event.deltaY;
        }}
        className={cn(
          'efm:flex efm:min-w-0 efm:flex-1 efm:items-stretch efm:overflow-x-auto efm:[scrollbar-width:thin]',
          slots?.tablist,
        )}
      >
        {order.map((id) => {
          const selected = id === active;
          const dirty = isDirty(id);
          const tabStatus = status(id);
          const isPreview = props.preview === id;
          const name = label(id);
          return (
            <ContextMenu.Root key={id}>
              <ContextMenu.Trigger asChild>
                <div
                  ref={(element) => {
                    if (element) tabRefs.current.set(id, element);
                    else tabRefs.current.delete(id);
                  }}
                  role='tab'
                  id={`${panelId}-tab-${id}`}
                  aria-selected={selected}
                  aria-controls={panelId}
                  aria-label={describe(id)}
                  aria-keyshortcuts='Delete'
                  tabIndex={id === tabStop ? 0 : -1}
                  title={describe(id)}
                  onKeyDown={(event) => onKeyDown(event, id)}
                  onFocus={() => setFocusId(id)}
                  onClick={() => {
                    if (!drag?.moving) onActivate(id);
                  }}
                  onDoubleClick={() => {
                    if (isPreview) props.onPromote?.(id);
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      onClose([id]);
                    }
                  }}
                  onMouseDown={(event) => {
                    if (event.button === 1) event.preventDefault(); // no autoscroll cursor
                  }}
                  onPointerDown={(event) => onPointerDown(event, id)}
                  className={cn(
                    'efm:group efm:relative efm:flex efm:max-w-[220px] efm:flex-none efm:cursor-pointer efm:items-center efm:gap-1.5 efm:border-r efm:border-border efm:pr-1.5 efm:pl-3 efm:text-[12px] efm:outline-none efm:select-none efm:[-webkit-touch-callout:none] efm:focus-visible:shadow-[inset_0_0_0_1px_var(--efm-focus,var(--efm-accent))] efm:pointer-coarse:text-[13px]',
                    selected
                      ? 'efm:bg-surface-raised efm:text-fg efm:shadow-[inset_0_2px_0_var(--efm-accent)]'
                      : 'efm:text-fg-muted efm:hover:bg-surface-raised/60 efm:hover:text-fg',
                    dragging?.id === id && 'efm:opacity-50',
                    slots?.tab,
                    selected ? slots?.tabActive : slots?.tabInactive,
                    isPreview && slots?.tabPreview,
                    dragging?.id === id && slots?.tabDragging,
                  )}
                >
                  {indicatorBefore === id && (
                    <span
                      aria-hidden='true'
                      className={cn('efm:absolute efm:top-1 efm:bottom-1 efm:-left-px efm:w-0.5 efm:bg-accent', slots?.dropIndicator)}
                    />
                  )}
                  {props.renderIcon && (
                    <span aria-hidden='true' className={cn('efm:flex efm:flex-none efm:items-center', slots?.tabIcon)}>
                      {props.renderIcon(id)}
                    </span>
                  )}
                  <span
                    className={cn(
                      'efm:min-w-0 efm:truncate',
                      isPreview && 'efm:italic',
                      tabStatus === 'missing' && 'efm:line-through efm:opacity-70',
                      (tabStatus === 'ended' || tabStatus === 'loading') && 'efm:opacity-60',
                      tabStatus === 'error' && 'efm:text-danger',
                      slots?.tabLabel,
                      isPreview && slots?.tabLabelPreview,
                      tabStatus === 'missing' && slots?.tabLabelMissing,
                      tabStatus === 'error' && slots?.tabLabelError,
                    )}
                  >
                    {name}
                  </span>
                  {props.renderBadge?.(id)}
                  <span
                    aria-hidden='true'
                    title={strings.close}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose([id]);
                    }}
                    className={cn(
                      'efm:relative efm:flex efm:h-[18px] efm:w-[18px] efm:flex-none efm:cursor-pointer efm:items-center efm:justify-center efm:rounded efm:text-[11px] efm:hover:bg-hover efm:pointer-coarse:h-7 efm:pointer-coarse:w-7 efm:pointer-coarse:text-[13px]',
                      slots?.closeButton,
                    )}
                  >
                    {/* A dirty dot until hovered, then the ✕, like VS Code. */}
                    <span className={cn(dirty ? 'efm:group-hover:hidden' : 'efm:hidden', slots?.dirtyMark)}>●</span>
                    <span
                      className={cn(
                        dirty
                          ? 'efm:hidden efm:group-hover:inline'
                          : selected
                            ? 'efm:inline'
                            : 'efm:invisible efm:group-hover:visible',
                      )}
                    >
                      ✕
                    </span>
                  </span>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className={cn(MENU_CONTENT, menu?.content, slots?.tabMenu)} data-efm='tab-menu'>
                  <ContextMenu.Item className={tabMenuItem} onSelect={() => onClose([id])}>
                    {strings.close}
                    {strings.closeShortcut && <span className={menuHint}>{strings.closeShortcut}</span>}
                  </ContextMenu.Item>
                  {order.length > 1 && (
                    <>
                      <ContextMenu.Item
                        className={tabMenuItem}
                        disabled={order.indexOf(id) === 0}
                        onSelect={() => onReorder(id, order.indexOf(id) - 1)}
                      >
                        {strings.moveLeft}
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className={tabMenuItem}
                        disabled={order.indexOf(id) === order.length - 1}
                        onSelect={() => onReorder(id, order.indexOf(id) + 1)}
                      >
                        {strings.moveRight}
                      </ContextMenu.Item>
                      <ContextMenu.Separator className={menuSeparator} />
                    </>
                  )}
                  {props.onCloseOthers && (
                    <ContextMenu.Item
                      className={tabMenuItem}
                      disabled={order.length < 2}
                      onSelect={() => props.onCloseOthers?.(id)}
                    >
                      {strings.closeOthers}
                    </ContextMenu.Item>
                  )}
                  {props.onCloseRight && (
                    <ContextMenu.Item
                      className={tabMenuItem}
                      disabled={order.indexOf(id) === order.length - 1}
                      onSelect={() => props.onCloseRight?.(id)}
                    >
                      {strings.closeRight}
                    </ContextMenu.Item>
                  )}
                  {props.onCloseSaved && (
                    <ContextMenu.Item className={tabMenuItem} onSelect={props.onCloseSaved}>
                      {strings.closeSaved}
                    </ContextMenu.Item>
                  )}
                  {props.onCloseAll && (
                    <ContextMenu.Item className={tabMenuItem} onSelect={props.onCloseAll}>
                      {strings.closeAll}
                    </ContextMenu.Item>
                  )}
                  {props.onReopen && (
                    <>
                      <ContextMenu.Separator className={menuSeparator} />
                      <ContextMenu.Item className={tabMenuItem} onSelect={props.onReopen}>
                        {strings.reopen}
                        {strings.reopenShortcut && (
                          <span className={menuHint}>{strings.reopenShortcut}</span>
                        )}
                      </ContextMenu.Item>
                    </>
                  )}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
        {indicatorAtEnd && (
          <span aria-hidden='true' className={cn('efm:my-1 efm:w-0.5 efm:flex-none efm:bg-accent', slots?.dropIndicator)} />
        )}
      </div>
      {/* Every open tab, for when the strip overflows: a real menu (arrow
          keys, typeahead, Escape, outside click) via Radix. */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={strings.allTabs}
          title={strings.allTabs}
          className={cn(
            'efm:flex-none efm:cursor-pointer efm:border-l efm:border-border efm:px-2 efm:text-[12px] efm:text-fg-muted efm:outline-none efm:hover:bg-surface-raised efm:hover:text-fg efm:focus-visible:shadow-[inset_0_0_0_1px_var(--efm-focus,var(--efm-accent))] efm:pointer-coarse:px-4 efm:pointer-coarse:text-[15px]',
            slots?.overflowButton,
          )}
        >
          ⌄
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align='end'
            className={cn(MENU_CONTENT, 'efm:max-h-80 efm:overflow-auto', menu?.content, slots?.overflowMenu)}
            data-efm='all-tabs-menu'
          >
            <DropdownMenu.RadioGroup value={active ?? ''} onValueChange={onActivate}>
              {order.map((id) => (
                <DropdownMenu.RadioItem
                  key={id}
                  value={id}
                  className={cn(
                    MENU_ITEM,
                    id !== active && 'efm:text-fg-muted',
                    menu?.item,
                    id === active ? slots?.overflowItemActive : slots?.overflowItem,
                  )}
                >
                  <span
                    className={cn(
                      'efm:truncate',
                      props.preview === id && 'efm:italic',
                      status(id) === 'missing' && 'efm:line-through',
                    )}
                  >
                    {label(id)}
                  </span>
                  {isDirty(id) && <span aria-label={strings.unsaved}>●</span>}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

export { TabStrip };
export type { TabStatus, TabStripProps, TabStripStrings };
