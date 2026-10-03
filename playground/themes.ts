import type { EfmTheme, EfmThemePresetName } from '../src/ui/index';

/**
 * A custom theme written the way an APP writes one: plain, unprefixed Tailwind
 * classes compiled by the app's own Tailwind (playground/playground.css), on
 * top of the default preset. `cn` drops the `efm:` default each class
 * conflicts with, so stylesheet order never decides the winner.
 *
 * Root var overrides recolour everything inside a root; the portaled menus and
 * the dialogs get the same block on their own slots.
 */
const WARM_VARS = [
  '[--efm-surface:#241c17]',
  '[--efm-surface-raised:#2f251e]',
  '[--efm-surface-sunken:#1b1511]',
  '[--efm-border:#4a3a2e]',
  '[--efm-hover:#3d3027]',
  '[--efm-control:#5a4637]',
  '[--efm-fg:#f3e6d3]',
  '[--efm-fg-muted:#b39c84]',
  '[--efm-fg-disabled:#7d6a58]',
  '[--efm-accent:#e9a55a]',
  '[--efm-on-accent:#2a1a0c]',
  '[--efm-focus:#ffd9a8]',
  '[--efm-warning:#f0c05a]',
  '[--efm-danger:#e5675a]',
  '[--efm-success:#9bbf6a]',
  '[--efm-overlay:rgb(20_12_6/0.7)]',
].join(' ');

const warmTheme: EfmTheme = {
  menu: {
    content: `${WARM_VARS} rounded-xl p-1.5 shadow-2xl`,
    item: 'rounded-lg data-[highlighted]:bg-[#4a3a2e]',
    hint: 'text-[#e9a55a]/70',
  },
  fileSidebar: {
    root: WARM_VARS,
    title: 'tracking-[0.2em] text-[#e9a55a]',
    // Descendant variant: the chevrons (`efm:text-fg-muted`, no slot of their
    // own) in amber. `efm\:` is the escaped prefix of the SELECTED class. The
    // backslash must be ONE backslash both in the source Tailwind scans and in
    // the runtime string, hence String.raw: an ordinary '…efm\\:…' literal is
    // scanned with two and silently matches nothing. The escape-free
    // alternative is `[&_[class~="efm:text-fg-muted"]]:` (the light preset).
    tree: String.raw`[&_.efm\:text-fg-muted]:text-[#e9a55a]`,
    row: 'mx-1 rounded-md',
    rowActive: 'bg-[#e9a55a]/20 text-[#ffd9a8]',
    accessTag: 'rounded-md',
  },
  tabStrip: {
    root: WARM_VARS,
    tab: 'mt-1 rounded-t-lg border-r-0',
    tabActive: 'bg-[#3a2c22] text-[#ffd9a8] shadow-[inset_0_-2px_0_#e9a55a]',
    tabLabelPreview: 'text-[#e9a55a]',
  },
  choiceDialog: {
    panel: `${WARM_VARS} rounded-2xl`,
    button: 'rounded-full',
    card: 'rounded-xl',
  },
  unsavedDialog: {
    panel: `${WARM_VARS} rounded-2xl`,
    button: 'rounded-full',
  },
  toaster: {
    viewport: WARM_VARS,
    toast: 'rounded-full px-4',
  },
  welcome: {
    layout: WARM_VARS,
    title: 'font-serif italic text-[#ffd9a8]',
    sectionTitle: 'text-[#e9a55a]',
  },
  emptyState: { root: WARM_VARS },
  panelError: { root: WARM_VARS },
};

type PlaygroundThemeName = 'default' | 'light' | 'warm';

const playgroundThemes: Record<PlaygroundThemeName, { preset: EfmThemePresetName; theme?: EfmTheme }> = {
  default: { preset: 'default' },
  light: { preset: 'light' },
  warm: { preset: 'default', theme: warmTheme },
};

export { playgroundThemes, warmTheme };
export type { PlaygroundThemeName };
