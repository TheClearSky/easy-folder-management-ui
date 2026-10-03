# Changelog

## 0.0.1 — unreleased

First release. Extracted from Nodestra's graph library and tabs (byte-copied, see `PROVENANCE.md`), then
generalized.

- `FilePolicy` / `extensionPolicy`: which files open, which a scan hides, the extension a new file gets, what UNLINK
  and UNDO may copy into the browser.
- `FileLibrary`: one tree over a browser store (`MemoryBackend`, IndexedDB) or a linked folder (`FolderBackend`,
  File System Access) — serial queue, mutation guard, link / unlink / reconnect / rescan, session undo of deletes,
  conflict detection; `access: 'read'` links; binary-safe `getFile`, `write(WriteData)` with streams and `at`
  (resume); streamed folder copies; `pickFolder()`.
- Tabs: `tabsReducer` (MRU, reopen, reorder, opt-in `preview` + `promote`), `tabId` / `parseTabId` /
  `defineTabKinds`, `createTabRecordStore` (reads Nodestra's stored records unchanged).
- `SaveController` and `Workspace` with a `DocumentAdapter`: open / switch / close with race guards, snapshots,
  autosave, unsaved-changes prompts, conflicts, journal, startup policies.
- `./react`: `useLibrarySnapshot`, `useWorkspace`.
- `./ui` + `./styles.css`: `FileSidebar`, `TabStrip`, `WelcomeLayout` / `WelcomeSection` / `WelcomeAction` /
  `RecentList`, `EmptyState`, `Toaster` (`createToaster`), `useUnsavedChangesDialog`, `PanelErrorBoundary`, `cn`.
  Tailwind 4 with `prefix(efm)`, no preflight, `--efm-*` theme variables.
