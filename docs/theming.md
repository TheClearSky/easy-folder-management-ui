# Theming

Every component in `./ui` is restyled from one optional, typed theme object — the pattern of
[react-blender-nodes](https://github.com/TheClearSky/react-blender-nodes)' `GraphThemeProvider`. Without a provider
the components keep their default look; providing one is purely additive.

```tsx
import type { ReactNode } from 'react';
import { FolderThemeProvider } from '@theclearsky/easy-folder-management-ui/ui';

export function Themed({ children }: { children: ReactNode }) {
  return (
    <FolderThemeProvider preset='light' theme={{ tabStrip: { tab: 'rounded-t-md' } }}>
      {children}
    </FolderThemeProvider>
  );
}
```

- `preset` — a built-in look: `'default'` (identical to no provider) or `'light'`.
- `theme` — a partial `EfmTheme` deep-merged over the preset; overrides win per slot.
- Inline `theme={{ … }}` literals are safe: the provider memoises resolution structurally (content-keyed), so the
  context value — and every themed component — only changes when the theme's content does.
- Providers do not inherit from outer providers: the innermost one wins wholesale.

## The API

All exported from `@theclearsky/easy-folder-management-ui/ui`.

| Export | What it is |
|---|---|
| `FolderThemeProvider` | `{ preset?, theme?, children }` — the single optional provider. Mount it around the components (or the whole app). |
| `useFolderTheme()` | The resolved theme of the nearest provider; `undefined` without one (never throws). |
| `EfmTheme` | The slot map type; one section type per component (`EfmFileSidebarSlots`, `EfmTabStripSlots`, `EfmMenuSlots`, `EfmChoiceDialogSlots`, `EfmUnsavedDialogSlots`, `EfmToasterSlots`, `EfmWelcomeSlots`, `EfmEmptyStateSlots`, `EfmPanelErrorSlots`). |
| `resolveTheme(preset?, overrides?)` | Pure `preset + overrides → theme` (what the provider memoises). An unknown preset name warns and falls back to `'default'`. |
| `mergeThemes(base, overrides?)` | The deep merge: plain objects merge recursively; strings and arrays REPLACE; `undefined` keeps the base; `null` replaces it. Neither input is mutated, but the result aliases untouched sections of `base` — treat resolved themes as immutable (the presets are deep-frozen; mutating one throws). `__proto__`/`constructor`/`prototype` keys are ignored; circular overrides throw. |
| `efmThemePresets`, `efmThemePresetNames`, `defaultEfmThemePresetName`, `EfmThemePresetName` | The presets by name. |
| `defaultEfmTheme` | Intentionally `{}`: the components' default classes ARE the default look. |
| `lightEfmTheme` | The full-coverage light preset — the reference for writing your own (`src/ui/theme/presets/lightEfmTheme.ts`). |

## How a slot is consumed

Each component reads the context and appends the slot after its defaults:

```tsx
const slots = useFolderTheme()?.tabStrip;
<div className={cn('<defaults>', slots?.root, className)} />;
```

Order is always **defaults → theme slot(s) → the `className` prop**. `cn` (clsx + tailwind-merge, made aware of the
`efm:` prefix) keeps only the LAST class per CSS property, so `cn('efm:bg-surface', 'bg-[#123]')` is `'bg-[#123]'` —
the default is gone from the DOM, and the winner never depends on which stylesheet loaded last. Defaults that do not
conflict stay. Variants merge per variant: `hover:bg-x` replaces `efm:hover:bg-hover`, never the plain background.
This is pinned by `src/__tests__/theme.test.ts` › `theme/cn conflict resolution`.

## The three mechanisms

1. **Slot classes** — the slot map below.
2. **CSS-variable overrides on a root slot** — every colour is a public `--efm-*` token, and the utilities read
   them through `var()` (`efm:bg-surface` → `background-color: var(--efm-surface)`), so an arbitrary-property class
   on a root — `fileSidebar: { root: '[--efm-accent:#e9a55a]' }` — recolours everything INSIDE that root. The
   variable names are deliberately unprefixed (declared outside `@theme`, so Tailwind's `prefix(efm)` cannot rename
   them); only the classes are prefixed. Setting the same variables from your own CSS (`:root { --efm-accent: … }`)
   works too, with no Tailwind at all.
3. **Descendant variants** — a class on a container that restyles a default class deeper inside, for an element
   with no slot of its own (or content you render through `renderIcon` / `rowExtras`):

   ```ts
   // escape-free: an attribute selector naming the prefixed class
   const tree = '[&_[class~="efm:text-fg-muted"]]:text-amber-400';
   // or the escaped class selector — note String.raw
   const tree2 = String.raw`[&_.efm\:text-fg-muted]:text-amber-400`;
   ```

   **The escaped `efm\:`.** The class being SELECTED is one of ours, so it carries the prefix, and in a class
   selector the `:` must be backslash-escaped (`.efm\:text-fg-muted`), or it reads as a pseudo-class. The backslash
   must be ONE backslash both in the source text Tailwind scans and in the runtime string. An ordinary literal
   `'[&_.efm\\:text-fg-muted]:…'` is one backslash at runtime but TWO in the source, so Tailwind (4.3, measured)
   generates a rule for a different class name and the theme silently does nothing. `String.raw` keeps them equal;
   the attribute form needs no escaping at all (the light preset uses it).

## Tokens

Declared on `:root` by `styles.css`; override them on `:root`, on any ancestor, or on a root slot.

| Variable | Default | Used for |
|---|---|---|
| `--efm-font` | `inherit` | text |
| `--efm-surface` | `#282828` | sidebar, strip, error panel |
| `--efm-surface-raised` | `#303030` | active tab, menus, dialogs, toasts |
| `--efm-surface-sunken` | `#1d1d1d` | Welcome, empty state, rename box, progress track |
| `--efm-border` | `#444444` | lines, separators, empty-state icon |
| `--efm-hover` | `#444444` | hover, selected rows |
| `--efm-control` | `#545454` | the error panel's button border |
| `--efm-fg` · `--efm-fg-muted` · `--efm-fg-disabled` | `#e6e6e6` · `#797979` · `#656565` | text · secondary text · inert files |
| `--efm-accent` | `#4772b3` | active tab line, open file's row, drop targets, primary buttons, links |
| `--efm-warning` · `--efm-danger` | `#ffa500` · `#ff4444` | unsaved dot, reconnect, notice strip · errors, danger buttons |
| `--efm-success` | `#4caf50` | not used by the components today (for your own UI) |
| `--efm-on-accent` | `#ffffff` | text on accent- and danger-coloured buttons |
| `--efm-overlay` | `rgb(0 0 0 / 0.6)` | the dialogs' backdrop |
| `--efm-focus` | *unset* → `--efm-accent` (the tree row's ring: → `--efm-fg-disabled`) | every focus ring |
| `--efm-selection` | *unset* → `--efm-accent` at 25 % | the open file's tree row |

`--efm-focus` and `--efm-selection` are deliberately NOT declared on `:root`: a declaration there reading
`var(--efm-accent)` would be resolved on `:root`, and a subtree that overrides `--efm-accent` would no longer move
them. Each use site falls back instead. Radii and shadows are not tokens — style them through slots.

## Slot map

`root`-like slots (marked ◉) are where root var overrides go. Portaled surfaces (marked ⧉) are rendered into
`document.body`: React context reaches them, so their slots work, but var overrides on the sidebar/strip roots do
not — repeat them on the portaled slot (as the light preset does) or set the variables on `:root`.

| Section | Slots | Rendered by |
|---|---|---|
| `menu` ⧉ | `content`, `item`, `hint`, `check`, `separator` | EVERY menu — the file context menu, the access menu, the tab menu, the all-tabs menu. The component-specific menu slots below are appended after these. `item`: use `data-[highlighted]:` for the hover/keyboard highlight and `data-[disabled]:` for disabled items. `hint`: shortcuts ("F2", "Del") and the access options' hints. `check`: the ✓ before the current access option. |
| `fileSidebar` | `root` ◉, `header`, `title`, `toolbarButton`, `modeRow`, `modeLabel`, `reconnectButton`, `accessTag`, `accessTagReadOnly`, `accessTagReadWrite`, `accessMenu` ⧉, `accessMenuItem` ⧉, `selectionBar`, `savingLabel`, `tree`, `row`, `rowSelected`, `rowActive`, `rowFocused`, `rowDropTarget`, `rowInert`, `rowChevron`, `rowIcon`, `rowLabel`, `rowRenameInput`, `dirtyDot`, `empty`, `dropLine`, `contextMenu` ⧉, `contextMenuItem` ⧉, `notice`, `error` | `FileSidebar`. `toolbarButton` is every small text button (New file/folder, Link, Unlink, Reconnect, Forget, Rename, Delete, Undo delete, the ✕ of the notice and the error). `modeLabel`: "Loading…", "In this browser", the folder name, "Folder linking unavailable". `rowActive`: the open file; `rowSelected`: the selection; `rowFocused`: keyboard focus; `rowDropTarget`: a folder under a drag; `rowInert`: a file the policy does not open. |
| `tabStrip` | `root` ◉, `tablist`, `tab`, `tabActive`, `tabInactive`, `tabPreview`, `tabDragging`, `tabIcon`, `tabLabel`, `tabLabelPreview`, `tabLabelMissing`, `tabLabelError`, `closeButton`, `dirtyMark`, `dropIndicator`, `overflowButton`, `overflowMenu` ⧉, `overflowItem` ⧉, `overflowItemActive` ⧉, `tabMenu` ⧉, `tabMenuItem` ⧉ | `TabStrip`. `tabActive` / `tabInactive` split the two states (the inactive one owns the hover tint). `tabPreview` is on the tab, `tabLabelPreview` on its label (the italic). `overflowItem` is every all-tabs entry EXCEPT the active tab's, which gets `overflowItemActive`. |
| `choiceDialog` | `panel` ◉, `title`, `body`, `button`, `actions`, `choice`, `choicePrimary`, `choiceDanger`, `choiceNeutral`, `cards`, `card`, `cardPrimary`, `cardDanger`, `cardNeutral`, `cardLabel`, `cardDescription`, `cancel`, `progressTrack`, `progressBar`, `progressText` | `useChoiceDialog()` — both views. `button`: every button (choices, cards, Cancel). Choices WITHOUT descriptions render in a button row (`choice*`); WITH descriptions they stack as cards (`card*`) — split because the two layouts have different tone defaults. `panel` also styles the backdrop: `backdrop:bg-black/30` (or `--efm-overlay`). |
| `unsavedDialog` | `panel` ◉, `title`, `list`, `body`, `actions`, `button`, `discard`, `cancel`, `save` | `useUnsavedChangesDialog()`. `button`: all three; `list`: the file names (several files). |
| `toaster` | `viewport` ◉, `toast`, `message`, `action`, `close` | `Toaster` |
| `welcome` | `layout` ◉, `content`, `title`, `grid`, `section`, `sectionTitle`, `action`, `actionLabel`, `actionHint`, `recentItem`, `recentEmpty` | `WelcomeLayout`, `WelcomeSection`, `WelcomeAction`, `RecentList` (its entries are `WelcomeAction`s: `action`, then `recentItem`) |
| `emptyState` | `root` ◉, `icon`, `title`, `rows`, `row`, `rowButton`, `hint` | `EmptyState`. `row`: every row; `rowButton`: clickable rows, after `row`. |
| `panelError` | `root` ◉, `title`, `message`, `retryButton` | `PanelErrorBoundary`'s fallback |

Every slot is rendered by `src/__tests__/themeRender.test.tsx` › `every slot of EfmTheme was rendered somewhere`
(except `rowDropTarget`, whose HTML5 drag jsdom cannot produce); its `ALL_SLOTS` list is checked against the type at
compile time.

**State caveat.** A base slot is appended in EVERY state of its element; a state slot (`rowSelected`, `tabActive`,
`overflowItemActive`, …) only in its state, after the base. So `row: 'bg-white'` also overrides the selected and
active backgrounds — set the state slots you want to keep distinct. The order mirrors the defaults: `rowSelected`
< `rowActive` < `rowFocused` < `rowDropTarget` < `rowInert`.

**Dialog caveat.** The dialogs are native `<dialog>`s shown with `showModal()`: they sit in the top layer but stay in
the DOM where you render `dialog.element`, so they inherit `--efm-*` from THAT position (usually the app root), not
from the sidebar. Theme them through `panel` (and the theme context reaches them wherever they render).

## How theme classes become CSS

A slot value is a list of class NAMES; a class does something only if a stylesheet defines it.

- **The built-in presets work out of the box.** Their classes are spelled with the `efm:` prefix
  (`efm:[--efm-surface:#f7f7f8]`) and compiled into the shipped `styles.css`.
- **Classes you write need your own Tailwind (v4) build** scanning the file that contains them. Unprefixed is the
  natural choice — `cn` handles the conflict with the `efm:` defaults either way. The playground does exactly this
  (`playground/playground.css`: utilities only, no preflight, scanning `playground/`).
- **Without Tailwind**, set the `--efm-*` variables from your own CSS, or put classes your own stylesheet defines
  into the slots.

## Live demo

`npm run playground` has a theme picker (also `?theme=default|light|warm`): `warm` is a custom theme written the way
an app writes one — unprefixed classes over the default preset, in `playground/themes.ts`.
