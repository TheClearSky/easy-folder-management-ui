/**
 * The theme: a typed map of per-component, per-slot class names. Every slot is
 * appended AFTER the component's default classes and BEFORE its `className`
 * prop — `cn('<defaults>', theme?.section?.slot, className)` — so a slot class
 * wins a conflict with a default (`bg-white` over `efm:bg-surface`: only the
 * former survives) and keeps every default it does not conflict with.
 *
 * Every slot is optional; a missing slot keeps the default look. Slot values
 * are class NAMES: the built-in presets' classes ship in `styles.css`, classes
 * you write need your own Tailwind build (see docs/theming.md).
 *
 * STATE SLOTS (`rowSelected`, `tabActive`, `overflowItemActive`, …) are
 * appended only in that state, after the element's base slot. A base slot
 * applies in EVERY state, so a theme that recolors `row` should also recolor
 * the state slots it wants to keep distinct.
 */

/** Shared by every menu: the file context menu, the access menu, the tab menu
 *  and the all-tabs menu (all portaled — root var overrides do not reach
 *  them). The component-specific menu slots are appended after these. */
type EfmMenuSlots = {
  /** The floating panel. */
  content?: string;
  /** Every item (use `data-[highlighted]:` for the keyboard/hover highlight,
   *  `data-[disabled]:` for disabled items). */
  item?: string;
  /** Secondary text in an item: shortcuts ("F2", "Del") and the access
   *  options' hints. */
  hint?: string;
  /** The ✓ before the current access option. */
  check?: string;
  separator?: string;
};

type EfmFileSidebarSlots = {
  /** The `<aside>`: surface, border, width — and the place for var overrides
   *  (`[--efm-accent:#e9d3a8]`), which reach everything IN the sidebar. */
  root?: string;
  /** The top row: title and the New file / New folder buttons. */
  header?: string;
  title?: string;
  /** Every small text button: New file/folder, Link, Unlink, Reconnect,
   *  Forget, Rename, Delete, Undo delete, the ✕ of the notice and error. */
  toolbarButton?: string;
  /** The mode row ("In this browser" / 📁 folder / reconnect). */
  modeRow?: string;
  /** The mode row's text: "Loading…", "In this browser", the folder name,
   *  "Folder linking unavailable". */
  modeLabel?: string;
  /** The Reconnect button (after `toolbarButton`; default warning colour). */
  reconnectButton?: string;
  /** The access tag ("Read only" / "Read & write"), in both states. */
  accessTag?: string;
  accessTagReadOnly?: string;
  accessTagReadWrite?: string;
  /** The access menu panel (after `menu.content`). */
  accessMenu?: string;
  /** Its two options (after `menu.item`). */
  accessMenuItem?: string;
  /** The Rename / Delete / Undo delete row. */
  selectionBar?: string;
  /** "Saving…" in the selection bar. */
  savingLabel?: string;
  /** The scrolling tree container. */
  tree?: string;
  /** Every row, in every state. */
  row?: string;
  /** Rows in the selection (default: hover background). */
  rowSelected?: string;
  /** The row of the file open in the editor (default: accent 25 %). */
  rowActive?: string;
  /** The row with keyboard focus (default: an inset ring). */
  rowFocused?: string;
  /** A folder row under a drag (default: accent 40 %). */
  rowDropTarget?: string;
  /** A file the policy does not open (default: greyed). */
  rowInert?: string;
  /** The ▸/▾ of a folder row. */
  rowChevron?: string;
  /** The icon cell (the default glyphs or `renderIcon`'s output). */
  rowIcon?: string;
  rowLabel?: string;
  /** The rename box. */
  rowRenameInput?: string;
  /** The unsaved-changes dot. */
  dirtyDot?: string;
  /** "No files yet." */
  empty?: string;
  /** The line shown while dragging. */
  dropLine?: string;
  /** The right-click menu panel (after `menu.content`). */
  contextMenu?: string;
  /** Its items (after `menu.item`). */
  contextMenuItem?: string;
  /** The warning strip at the bottom (`snapshot.notice`). */
  notice?: string;
  /** The error strip at the bottom (`snapshot.error`). */
  error?: string;
};

type EfmTabStripSlots = {
  /** The strip: surface, border, height — and the place for var overrides. */
  root?: string;
  /** The scrolling `role=tablist`. */
  tablist?: string;
  /** Every tab, in every state. */
  tab?: string;
  /** The active tab (default: raised surface, accent top line). */
  tabActive?: string;
  /** Every other tab (default: muted text, hover tint). */
  tabInactive?: string;
  /** The preview tab (the label's italic is `tabLabelPreview`). */
  tabPreview?: string;
  /** The tab being dragged. */
  tabDragging?: string;
  /** The `renderIcon` cell. */
  tabIcon?: string;
  tabLabel?: string;
  tabLabelPreview?: string;
  /** A tab whose file was deleted (default: struck through). */
  tabLabelMissing?: string;
  /** A tab in `'error'` status (default: danger colour). */
  tabLabelError?: string;
  /** The ✕ / dirty-dot button cell. */
  closeButton?: string;
  /** The ● shown on a dirty tab until it is hovered. */
  dirtyMark?: string;
  /** The insertion line while dragging. */
  dropIndicator?: string;
  /** The ⌄ "All open tabs" button. */
  overflowButton?: string;
  /** The all-tabs menu panel (after `menu.content`). */
  overflowMenu?: string;
  /** Its items that are NOT the active tab (after `menu.item`). */
  overflowItem?: string;
  /** Its item for the active tab. */
  overflowItemActive?: string;
  /** A tab's right-click menu panel (after `menu.content`). */
  tabMenu?: string;
  /** Its items (after `menu.item`). */
  tabMenuItem?: string;
};

type EfmChoiceDialogSlots = {
  /** The `<dialog>` panel, for both the question and the progress view. Its
   *  `::backdrop` is styled from here with the `backdrop:` variant
   *  (`backdrop:bg-black/30`) or through `--efm-overlay`. */
  panel?: string;
  title?: string;
  body?: string;
  /** Every button: choices, cards and Cancel. */
  button?: string;
  /** The row of buttons (and the row holding Cancel under cards). */
  actions?: string;
  /** A choice in the button row (choices WITHOUT descriptions). */
  choice?: string;
  choicePrimary?: string;
  choiceDanger?: string;
  choiceNeutral?: string;
  /** The column of cards (choices WITH a description stack as cards). */
  cards?: string;
  card?: string;
  cardPrimary?: string;
  cardDanger?: string;
  cardNeutral?: string;
  cardLabel?: string;
  cardDescription?: string;
  /** The Cancel button. */
  cancel?: string;
  /** The progress view's track, bar and text. */
  progressTrack?: string;
  progressBar?: string;
  progressText?: string;
};

type EfmUnsavedDialogSlots = {
  /** The `<dialog>` panel (`backdrop:` classes style its backdrop). */
  panel?: string;
  title?: string;
  /** The list of file names (several files). */
  list?: string;
  body?: string;
  actions?: string;
  /** Every button. */
  button?: string;
  discard?: string;
  cancel?: string;
  save?: string;
};

type EfmToasterSlots = {
  /** The fixed bottom-right stack. */
  viewport?: string;
  toast?: string;
  message?: string;
  action?: string;
  close?: string;
};

type EfmWelcomeSlots = {
  /** `WelcomeLayout`'s scrolling root — the place for var overrides. */
  layout?: string;
  /** The centred column. */
  content?: string;
  title?: string;
  /** The two-column grid of sections. */
  grid?: string;
  section?: string;
  sectionTitle?: string;
  /** Every `WelcomeAction` (RecentList's entries too). */
  action?: string;
  actionLabel?: string;
  actionHint?: string;
  /** RecentList's entries (after `action`). */
  recentItem?: string;
  /** RecentList's "Nothing opened yet." */
  recentEmpty?: string;
};

type EfmEmptyStateSlots = {
  /** The root — the place for var overrides. */
  root?: string;
  icon?: string;
  title?: string;
  /** The column of rows. */
  rows?: string;
  /** Every row (static and clickable). */
  row?: string;
  /** Clickable rows (after `row`). */
  rowButton?: string;
  hint?: string;
};

type EfmPanelErrorSlots = {
  root?: string;
  title?: string;
  message?: string;
  retryButton?: string;
};

type EfmTheme = {
  menu?: EfmMenuSlots;
  fileSidebar?: EfmFileSidebarSlots;
  tabStrip?: EfmTabStripSlots;
  choiceDialog?: EfmChoiceDialogSlots;
  unsavedDialog?: EfmUnsavedDialogSlots;
  toaster?: EfmToasterSlots;
  welcome?: EfmWelcomeSlots;
  emptyState?: EfmEmptyStateSlots;
  panelError?: EfmPanelErrorSlots;
};

export type {
  EfmChoiceDialogSlots,
  EfmEmptyStateSlots,
  EfmFileSidebarSlots,
  EfmMenuSlots,
  EfmPanelErrorSlots,
  EfmTabStripSlots,
  EfmTheme,
  EfmToasterSlots,
  EfmUnsavedDialogSlots,
  EfmWelcomeSlots,
};
