# Changelog

## 0.0.4 — 2026-10-03

Unlink with a choice, folder access modes, and a browser library that holds videos without holding them in memory.

- **BREAKING** `FileLibrary.unlink(options)` takes `{ keep, signal?, onProgress? }` and resolves `{ kept, skipped,
  bytes }`. `keep: true` copies every folder on disk (empty ones too) and the files the policy's `copyOnUnlink`
  allows into the browser; `keep: false` leaves the in-browser library empty (no leftover folders). Nothing on disk is
  touched either way. KEEP is all-or-nothing: out of space, a failure or a cancel (`signal`, `cancelUnlink()`) deletes
  the partial copy and the folder stays linked, unchanged; unreadable files are skipped and reported. It asks for
  `navigator.storage.persist()` first. Progress is throttled (~10/s) and mirrored in `snapshot.unlinkProgress`.
- New `FileLibrary.planUnlink()`: counts, the bytes KEEP would copy (from file metadata), `navigator.storage.estimate()`
  free space and whether it fits — for the dialog shown before the choice.
- **BREAKING** `Workspace`: unlinking asks the new injectable `chooseUnlink(plan) → 'keep' | 'remove' | 'cancel'`
  (default: keep) instead of `confirm({ kind: 'unlink' })`, which is gone from `ConfirmRequest`.
  `workspace.unlink({ signal?, onProgress? })`, `workspace.cancelUnlink()`. Tabs of files no longer in the library
  close after an unlink.
- **BREAKING (behaviour)** `extensionPolicy`'s default `copyOnUnlink` is now every OPENABLE file, binary included (it
  was text only — binary policies used to drop every video on unlink and keep empty folders). `keepForUndo` stays
  text only.
- Blob stores: binary contents of the in-browser library stream into the Origin Private File System — never through
  memory — and `getFile()` returns them as disk-backed Files. `FileLibrary({ blobStore })`: `'auto'` (default; OPFS
  directory `<store name>.blobs` for a `'binary'` policy over `createIndexedDbStore`, else the key-value store as
  before), a `BlobStore`, or `null`. New `createOpfsBlobStore(dir)`, `createMemoryBlobStore()`, `canUseOpfs()`,
  `estimateStorage()`, `requestPersistentStorage()`, `formatBytes()`. Text stays a string under `file:<id>`, so
  libraries stored by earlier versions (Nodestra's) read unchanged; old binary Blobs in IndexedDB still read. Entries
  orphaned by a tab closed mid-copy are swept at start-up (only when no other tab holds the store's Web Lock, and not
  within a minute of their last write). `KeyValueStore` gains an optional `name`.
- Folder access modes: `link(handle, { access })` (library and workspace), persisted next to the folder handle
  (`folderAccess` key) so a reload asks for THAT access; `snapshot.folderAccess`. `FileLibrary.setAccess(access)` /
  `Workspace.setFolderAccess(access)` switch either way: an upgrade asks the browser first thing in the click (a
  refusal keeps read-only and says so in `notice`); a downgrade saves the open file's pending edit and waits for
  queued writes. `reconnect({ access })`: after a reload without write permission, reconnect read & write or continue
  read-only. `requestWriteAccess()` is now `setAccess('readwrite')` — **BREAKING (behaviour)**: the upgrade is
  persisted, no longer session-only. Writes in read-only mode are refused with "This folder is open read-only. Switch
  it to Read & write to change it."
- Deletes: `ConfirmRequest` `delete` gains `permanent` (files Undo cannot bring back). In the browser library a delete
  frees the OPFS bytes at once. Undo is offered only when it would restore something (not after deleting videos).
- An abort (`AbortError`) is no longer shown as an `error`.
- `./ui`: `useChoiceDialog()` → `{ ask(request) → id | 'cancel', showProgress(view | null), element }` — one native
  `<dialog>` (focus trapped, Escape = cancel, initial focus on the primary choice else Cancel, `efm:` styled, larger
  on touch). Wordings: `accessChoice()`, `unlinkChoice(plan)` (sizes, free space, Keep disabled when it will not fit),
  `unlinkProgressView(progress, onCancel)`, `confirmChoice(request)` (link, delete — says what cannot be undone);
  strings overridable (`LibraryDialogStrings`).
- `FileSidebar`: a "Read only" / "Read & write" tag next to the folder name (`access`, default
  `snapshot.folderAccess`; `showAccessTag={false}` hides it); with `onChangeAccess` it is a menu to switch. In
  reconnect mode a read & write folder also offers "Read only". `onReconnect(access?)`. New strings.
- Theming (`./ui`), react-blender-nodes' pattern: `FolderThemeProvider` (`preset`, `theme`; memoised by content, so
  inline literals are fine) and `useFolderTheme()` (non-throwing, `undefined` without a provider) give every component
  typed per-slot class names — `EfmTheme` sections `fileSidebar`, `tabStrip`, `menu` (shared by all four menus),
  `choiceDialog`, `unsavedDialog`, `toaster`, `welcome`, `emptyState`, `panelError`, with state slots (`rowSelected`,
  `rowActive`, `tabActive`, `overflowItemActive`, …). Each slot is appended after the defaults and before `className`;
  the prefix-aware `cn` keeps only the last class per property, so an unprefixed `bg-[#123]` replaces
  `efm:bg-surface`. `mergeThemes`, `resolveTheme`, presets `'default'` (empty: the defaults are the look) and
  `'light'` (full coverage, the reference), all deep-frozen. The theme reaches the portaled menus; the dialogs read it
  where their `element` renders. Without a provider nothing changes (verified pixel-identical in Chrome). Slot map and
  caveats: `docs/theming.md`.
- New tokens `--efm-on-accent` (text on accent/danger buttons, `#fff`) and `--efm-overlay` (dialog backdrop,
  `rgb(0 0 0 / 0.6)`); optional, unset by default, `--efm-focus` (focus rings, falls back to `--efm-accent`) and
  `--efm-selection` (the open file's row, falls back to the accent at 25 %). Defaults unchanged.
- `WelcomeSection` and `WelcomeAction` accept `className`.
- `npm run playground` (script added) drives a real `Workspace` over IndexedDB + OPFS, with a demo folder built in OPFS, and a theme picker (`?theme=default|light|warm`; `warm` is a custom theme in unprefixed classes, compiled by the playground's own Tailwind).

### Touch (prepared as 0.0.3, which was never published — it ships in 0.0.4)

Touch and small screens.

- `TabStrip`: a finger swipe scrolls the strip instead of starting a drag-reorder (touch never drags); long-press
  opens the tab menu, which gains **Move Left / Move Right** (also useful from the keyboard). New strings
  `moveLeft` / `moveRight`.
- Touch screens (`pointer: coarse`) get larger targets: tree rows 40 px, tab strip 42 px, bigger close buttons, menu
  items, toolbar buttons and Welcome actions. Mouse layouts are unchanged.
- `WelcomeLayout` uses less padding on narrow screens.
- `FileSidebar` and `TabStrip` sizes stay overridable through `className` (e.g. a full-width mobile drawer).

## 0.0.2 — 2026-10-03

Documentation release; no code changes.

- A new README: what it is and why, a screenshot, a complete quick start (a Markdown notes app with autosave),
  recipes (read-only video library, streamed and resumed writes, app-owned tab kinds, preview tabs), the API at a
  glance, theming variables, browser support, and the projects that use it. Every code sample is type-checked
  against the published API.
- `package.json` gains `homepage` and `bugs` links (shown on npm).

## 0.0.1 — 2026-10-03

First release. Extracted from Nodestra's graph library and tabs (byte-copied, see `PROVENANCE.md`), then
generalized.

- `FilePolicy` / `extensionPolicy`: which files open, which a scan hides, the extension a new file gets, what UNLINK
  and UNDO may copy into the browser.
- `FileLibrary`: one tree over a browser store (`MemoryBackend`, IndexedDB) or a linked folder (`FolderBackend`,
  File System Access) — serial queue, mutation guard, link / unlink / reconnect / rescan, session undo of deletes,
  conflict detection; `access: 'read'` links; binary-safe `getFile`, `write(WriteData)` with streams and `at`
  (resume); streamed folder copies; `pickFolder()`; `requestWriteAccess()` upgrades a read-only link from a click.
- Tabs: `tabsReducer` (MRU, reopen, reorder, opt-in `preview` + `promote`), `tabId` / `parseTabId` /
  `defineTabKinds`, `createTabRecordStore` (reads Nodestra's stored records unchanged).
- `SaveController` and `Workspace` with a `DocumentAdapter`: open / switch / close with race guards, snapshots,
  autosave, unsaved-changes prompts, conflicts, journal, startup policies.
- `./react`: `useLibrarySnapshot`, `useWorkspace`.
- `./ui` + `./styles.css`: `FileSidebar`, `TabStrip`, `WelcomeLayout` / `WelcomeSection` / `WelcomeAction` /
  `RecentList`, `EmptyState`, `Toaster` (`createToaster`), `useUnsavedChangesDialog`, `PanelErrorBoundary`, `cn`.
  Tailwind 4 with `prefix(efm)`, no preflight, `--efm-*` theme variables.
