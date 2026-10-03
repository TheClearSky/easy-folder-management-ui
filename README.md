<h1 align="center">easy-folder-management-ui</h1>

<p align="center">
  <strong>A VS Code-style file library and tab strip for web apps.</strong><br />
  Link a folder on the user's disk or keep files in the browser, browse them in a tree, open them in tabs —
  without ever loading a 4&nbsp;GB file into memory.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@theclearsky/easy-folder-management-ui"><img alt="npm" src="https://img.shields.io/npm/v/@theclearsky/easy-folder-management-ui?color=4772b3&label=npm" /></a>
  <a href="https://github.com/TheClearSky/easy-folder-management-ui/actions/workflows/library-deploy.yml"><img alt="CI" src="https://github.com/TheClearSky/easy-folder-management-ui/actions/workflows/library-deploy.yml/badge.svg" /></a>
  <img alt="types included" src="https://img.shields.io/badge/types-included-4772b3" />
  <img alt="provenance" src="https://img.shields.io/badge/npm-provenance-4caf50" />
  <a href="./LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-797979" /></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@theclearsky/easy-folder-management-ui">npm</a> ·
  <a href="https://github.com/TheClearSky/easy-folder-management-ui">GitHub</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#recipes">Recipes</a> ·
  <a href="#api-at-a-glance">API</a> ·
  <a href="#theming">Theming</a> ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img alt="The file sidebar and tab strip: a linked folder of videos, a dirty tab, an italic preview tab, an ended share tab and a context menu with an app-defined action"
       src="./docs/preview.png" width="900" />
</p>

---

## Why

Every app that edits or plays files ends up rebuilding the same things: a file tree, tabs, "unsaved changes?",
re-asking for folder permission, not losing an edit when the user switches tabs mid-save. This package is those
pieces, extracted from a production app, generalized, and tested.

|  |  |
|---|---|
| 📁 **Real folders, or none** | Link a folder with the File System Access API, or keep files in the browser (IndexedDB). Reconnect after a reload with one click. Read-only links for apps that never write. |
| 🎞️ **Binary-safe** | `getFile()` returns the browser's disk-backed `File` — an object URL plays a 4&nbsp;GB video without reading it. Writes take streams and resume at an offset; folder moves copy through streams. |
| 🗂️ **Tabs that aren't only files** | Tab ids are `kind:key` — files, a Welcome page, or anything your app defines (a live stream). MRU focus, reopen, drag reorder, optional VS Code preview tabs, restored by path after a reload. |
| 🛟 **Doesn't lose work** | A framework-free `Workspace` handles open / switch / close with race guards, autosave, unsaved-changes prompts, on-disk conflict detection, a crash journal and per-tab snapshots. |
| 🎨 **Styled, but isolated** | Ships its own stylesheet: every class is prefixed `efm:`, there is no global reset, and the look is themed through `--efm-*` variables. Works next to your own Tailwind (or none). |
| ♿ **Keyboard-first** | WAI-ARIA tree and tabs: arrows, Home/End, F2 rename, Delete, Ctrl+Shift+←/→ to move a tab, Shift+F10 menus (Radix). |

## Install

```sh
npm install @theclearsky/easy-folder-management-ui
```

`react` and `react-dom` (18+) are optional peers — only the `./react` and `./ui` entries use them. The core runs
anywhere, Node included.

| Entry | What's in it |
|---|---|
| `@theclearsky/easy-folder-management-ui` | Core: `FileLibrary`, backends, `FilePolicy`, tabs reducer, tab kinds, `Workspace`, `SaveController` |
| `…/react` | `useWorkspace`, `useLibrarySnapshot` |
| `…/ui` | `FileSidebar`, `TabStrip`, `WelcomeLayout`, `EmptyState`, `Toaster`, `useUnsavedChangesDialog`, … |
| `…/styles.css` | The stylesheet for `./ui` (import once) |

## Quick start

A Markdown notes app: link a folder, open notes in tabs, edit, autosave.

```tsx
import { useState } from 'react';
import {
  canLinkFolders,
  createIndexedDbStore,
  defineTabKinds,
  extensionPolicy,
  FileLibrary,
  pickFolder,
  Workspace,
} from '@theclearsky/easy-folder-management-ui';
import { useWorkspace } from '@theclearsky/easy-folder-management-ui/react';
import { FileSidebar, TabStrip } from '@theclearsky/easy-folder-management-ui/ui';
import '@theclearsky/easy-folder-management-ui/styles.css';

// 1. Which files your app opens.
const policy = extensionPolicy({ openable: ['.md'], content: 'text', defaultExtension: '.md' });

// 2. A library (where files live) and a workspace (what's open).
let editorText = '';
function createWorkspace(show: (text: string | null) => void) {
  const library = new FileLibrary({ store: createIndexedDbStore('notes.library'), policy });
  return new Workspace<string>({
    library,
    kinds: defineTabKinds({ file: { persist: 'file' }, welcome: { persist: 'key' } }),
    documents: {
      load: async (file) => ({ ok: true, content: await file.readText() }),
      install: (text) => show((editorText = text)),
      closeEditor: () => show(null),
      serialize: () => editorText, // present → the workspace autosaves
    },
  });
}

// 3. Render it.
export function NotesApp() {
  const [text, setText] = useState<string | null>(null);
  const { workspace, snapshot } = useWorkspace(() => createWorkspace(setText));
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <FileSidebar
        snapshot={snapshot.library}
        policy={policy}
        activeFileId={snapshot.activeFileId}
        readOnly={snapshot.readOnly}
        canLinkFolders={canLinkFolders()}
        onOpen={(id, { preview }) => void workspace.openFile(id, { preview })}
        onNewFile={(folder) => void workspace.createAndOpen(folder, 'Untitled.md', '')}
        onRename={(id, name) => void workspace.rename(id, name)}
        onDelete={(ids) => void workspace.remove(ids)}
        // The picker first, straight from the click (it needs the user gesture).
        onLink={() => void pickFolder().then((folder) => folder && workspace.link(folder))}
        onReconnect={() => void workspace.reconnect()}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <TabStrip
          order={snapshot.tabs.order}
          active={snapshot.tabs.active}
          preview={snapshot.tabs.preview}
          label={(id) => workspace.label(id)}
          isDirty={(id) => workspace.isDirty(id)}
          status={(id) => (workspace.isTabMissing(id) ? 'missing' : 'ok')}
          onActivate={(id) => void workspace.activateTab(id)}
          onClose={(ids) => void workspace.closeTabs(ids)}
          onReorder={(id, to) => workspace.reorderTab(id, to)}
          onPromote={(id) => workspace.promoteTab(id)}
          onReopen={() => void workspace.reopenClosedTab()}
          panelId='editor'
        />
        <textarea
          id='editor'
          value={text ?? ''}
          disabled={text === null}
          onChange={(event) => {
            setText((editorText = event.target.value));
            workspace.contentChanged();
          }}
        />
      </div>
    </div>
  );
}
```

`npm run playground` in this repo renders every component on a bare page.

## Recipes

### A read-only video library

```ts
const library = new FileLibrary({
  store: createIndexedDbStore('videos.library'),
  policy: extensionPolicy({ openable: ['.mp4', '.mkv', '.webm'], content: 'binary' }),
  access: 'read', // the browser asks for read access only; every change is refused
});

const workspace = new Workspace<File>({
  library,
  kinds: defineTabKinds({ file: { persist: 'file' }, welcome: { persist: 'key' } }),
  documents: {
    // Disk-backed: nothing is read until the <video> asks for it.
    load: async (file) => ({ ok: true, content: await file.getFile() }),
    install: (video) => (player.src = URL.createObjectURL(video)),
    closeEditor: () => player.removeAttribute('src'),
  },
});
```

Need to write after all (say, saving a download)? `await library.requestWriteAccess()` from a click upgrades the
link for the session.

### Stream a large file to disk, and resume

```ts
const id = await library.createFile(folderId, 'movie.mkv.part', firstChunks); // ReadableStream
await library.write(id, moreChunks, { at: bytesAlreadyWritten });             // resume after a blip
```

A failed stream leaves the previous contents untouched (the browser commits on close). Hide `*.part` from the tree
with your policy's `isHidden`.

### Tabs your app owns

```ts
const kinds = defineTabKinds({
  file: { persist: 'file' },   // restored by path
  welcome: { persist: 'key' }, // restored as-is
  share: { persist: false },   // a live stream: gone after a reload
});
await workspace.openTab(tabId('share', 's_9f2c'));
```

Give non-file tabs a label with the workspace's `label` option and a status (`ended`, `loading`, …) with
`TabStrip`'s `status` prop.

### Preview tabs (VS Code's italic tab)

`FileSidebar previewOnClick` opens on single click as a preview that the next single click replaces; a
double-click, an edit or `promoteTab` keeps it.

## API at a glance

| | |
|---|---|
| `extensionPolicy({ openable, content, defaultExtension?, isHidden?, copyOnUnlink?, keepForUndo? })` | What opens, what a scan skips, what may be copied into the browser |
| `new FileLibrary({ store, policy, access?, beforeMutate? })` | `init` · `link` · `unlink` · `reconnect` · `rescan` · `getFile` · `readText` · `write` · `createFile` · `createFolder` · `rename` · `move` · `remove` · `undoDelete` · `requestWriteAccess` |
| `createIndexedDbStore(name)` / `createMemoryStore()` | Where the library persists (a folder handle survives a reload only in IndexedDB) |
| `pickFolder({ access?, id? })` · `canLinkFolders()` | The folder picker, and whether this browser has one |
| `new Workspace({ library, kinds, documents, … })` | `openFile` · `openTab` · `activateTab` · `closeTabs` (+ others / right / saved / all) · `reopenClosedTab` · `promoteTab` · `reorderTab` · `contentChanged` · `saveNow` · `setAutoSave` · `overwriteConflict` · `reloadConflict` · `link` · `unlink` · `reconnect` · `rename` · `move` · `remove` |
| `DocumentAdapter` | Required: `load`, `install`, `closeEditor`. Optional: `serialize` (enables saving), `signature`, `capture` / `restore` (per-tab snapshots), `silence`, `onFirstSaveOfWarnedFile` |
| `tabsReducer` · `tabId` · `parseTabId` · `defineTabKinds` · `createTabRecordStore` | The tabs model on its own, if you don't want the workspace |

Prompts are yours: pass `confirmUnsaved` (e.g. `useUnsavedChangesDialog().ask`) and `confirm` to the workspace —
the library never calls `window.confirm`.

## Theming

Override any variable on `:root` or on an ancestor of the components. The defaults are a dark, Blender-like palette.

```css
:root {
  --efm-surface: #ffffff;
  --efm-surface-raised: #f4f5f7;
  --efm-border: #dfe1e6;
  --efm-fg: #172b4d;
  --efm-fg-muted: #5e6c84;
  --efm-accent: #0c66e4;
}
```

| Variable | Used for | | Variable | Used for |
|---|---|---|---|---|
| `--efm-font` | text (inherits) | | `--efm-fg` | text |
| `--efm-surface` | sidebar, strip | | `--efm-fg-muted` | secondary text |
| `--efm-surface-raised` | active tab, menus | | `--efm-fg-disabled` | inert files |
| `--efm-surface-sunken` | Welcome, inputs | | `--efm-accent` | focus, active, drop target |
| `--efm-border` / `--efm-hover` | lines / hover | | `--efm-warning` · `--efm-danger` · `--efm-success` | unsaved · errors · saved |

Pass `className` to any component to add your own classes; they win conflicts with the defaults.

## Browser support

| | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| In-browser library, tabs, workspace, UI | ✅ | ✅ | ✅ |
| Link a local folder | ✅ desktop | — (no File System Access) | — |

`canLinkFolders()` tells you which; `FileSidebar` explains it to the user when linking is unavailable.

## Built to be trusted

- **124 tests** run in Node against an in-memory File System Access implementation, stripped to what stable Chrome
  supports, so a test never passes only because the fake is more capable than the browser.
- The workspace's tests pin the data-loss bugs found and fixed in production: an edit made while switching tabs is
  saved to the right file, a superseded open restores what it took, "Don't save" sticks, a file changed on disk is
  never overwritten without asking.
- Every release is built and published by CI with npm provenance.

## Used by

| Project | Status |
|---|---|
| **watch-together** — watch local videos together, peer to peer, from a static page | coming soon |
| **Nodestra** — a node-based sound design app (where this library was born) | migration coming soon |

## License

MIT © 2026 Deepak Prasad
