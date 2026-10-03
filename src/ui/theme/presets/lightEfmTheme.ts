import type { EfmTheme } from '../efmThemeTypes';

/**
 * A full-coverage light preset, and the reference for writing your own.
 *
 * Three mechanisms compose here, all className-driven (built-in presets spell
 * their classes with the `efm:` prefix so they compile into the shipped
 * `styles.css`; a theme of your own uses YOUR Tailwind, unprefixed):
 *
 * 1. CSS-variable overrides on every ROOT slot (`[--efm-surface:#f7f7f8]`).
 *    Every colour is a `--efm-*` token, so one block of overrides recolours
 *    everything inside that root. Portaled menus and the dialogs are not
 *    inside the sidebar or the strip, so the same block goes on `menu.content`
 *    and on each dialog `panel`.
 * 2. Plain slot classes appended after the defaults (`cn` drops the default a
 *    slot class conflicts with): softer shadows, the active tab's line moved
 *    to the bottom (`tabStrip.tabActive`, a STATE slot).
 * 3. A descendant variant (`fileSidebar.tree`) reaching a default class with
 *    no slot of its own. It selects the prefixed class with an ATTRIBUTE
 *    selector, `[class~="efm:text-fg-muted"]`, which needs no escaping. (The
 *    escaped `.efm\:text-fg-muted` form written in an ordinary string literal
 *    as `'…efm\\:…'` reaches Tailwind's scanner with TWO backslashes and
 *    silently generates nothing — measured; see docs/theming.md.)
 */
const LIGHT_VARS = [
  'efm:[--efm-surface:#f7f7f8]',
  'efm:[--efm-surface-raised:#ffffff]',
  'efm:[--efm-surface-sunken:#eeeef1]',
  'efm:[--efm-border:#d9dae0]',
  'efm:[--efm-hover:#e6e7eb]',
  'efm:[--efm-control:#c3c5cc]',
  'efm:[--efm-fg:#1f2328]',
  'efm:[--efm-fg-muted:#5f6772]',
  'efm:[--efm-fg-disabled:#a4a9b1]',
  'efm:[--efm-accent:#0969da]',
  'efm:[--efm-warning:#9a6700]',
  'efm:[--efm-danger:#cf222e]',
  'efm:[--efm-success:#1a7f37]',
  'efm:[--efm-overlay:rgb(31_35_40/0.35)]',
].join(' ');

const SOFT_SHADOW = 'efm:shadow-[0_8px_24px_rgb(31_35_40/0.14)]';

const lightEfmTheme: EfmTheme = {
  menu: {
    content: `${LIGHT_VARS} ${SOFT_SHADOW}`,
  },
  fileSidebar: {
    root: LIGHT_VARS,
    // Folder chevrons a step quieter than the muted text around them.
    tree: 'efm:[&_[class~="efm:text-fg-muted"]]:text-[#8c929b]',
    rowActive: 'efm:font-medium',
    accessTagReadWrite: 'efm:bg-accent/10',
  },
  tabStrip: {
    root: LIGHT_VARS,
    tabActive: 'efm:shadow-[inset_0_-2px_0_var(--efm-accent)]',
  },
  choiceDialog: {
    panel: `${LIGHT_VARS} ${SOFT_SHADOW} efm:border-transparent`,
  },
  unsavedDialog: {
    panel: `${LIGHT_VARS} ${SOFT_SHADOW} efm:border-transparent`,
  },
  toaster: {
    viewport: LIGHT_VARS,
    toast: SOFT_SHADOW,
  },
  welcome: {
    layout: LIGHT_VARS,
    action: 'efm:hover:bg-hover',
  },
  emptyState: {
    root: LIGHT_VARS,
  },
  panelError: {
    root: LIGHT_VARS,
  },
};

export { lightEfmTheme };
