# @theclearsky/easy-folder-management-ui

A VS Code-style file library and tab strip for web apps: link a folder on the user's disk (File System Access) or
keep files in the browser, browse them in a tree, open them in tabs.

- **Binary-safe.** A linked 4 GB video is never read into memory: `getFile()` returns the browser's disk-backed
  `File`, writes accept streams and resume at an offset, folder moves copy through streams.
- **Your files, your rules.** A `FilePolicy` says which files open, which are hidden, and what may be copied into
  the browser. Folders can be linked read-only.
- **Tabs that are not files.** Tab ids are `kind:key` — files, a Welcome page, or anything your app defines (a live
  stream). Optional VS Code preview tabs. Tabs survive reloads by path.
- **A workspace that does not lose work.** Opening, switching and closing files with autosave, unsaved-changes
  prompts, conflict detection, crash journal and per-tab snapshots — framework-free and tested in Node.
- **Styled, but isolated.** The shipped stylesheet is prefixed (`efm:`), has no preflight, and is themed through
  `--efm-*` variables.

The inspiration: the graph library and tabs of Nodestra, extracted and generalized.

MIT. `react` and `react-dom` are optional peers (only `./react` and `./ui` use them).

## 1. Describe your files

```ts
import { createIndexedDbStore, extensionPolicy, FileLibrary } from '@theclearsky/easy-folder-management-ui';

const library = new FileLibrary({
  store: createIndexedDbStore('my-app.library'),
  policy: extensionPolicy({ openable: ['.mp4', '.mkv'], content: 'binary' }),
  access: 'read',
});
```

## 2. Open them in a workspace

```ts
import { defineTabKinds, Workspace } from '@theclearsky/easy-folder-management-ui';

const workspace = new Workspace({
  library,
  kinds: defineTabKinds({ file: { persist: 'file' }, welcome: { persist: 'key' } }),
  documents: {
    load: async (file) => ({ ok: true, content: await file.getFile() }),
    install: (video) => showVideo(video),
    closeEditor: () => showVideo(null),
  },
  welcomeTab: 'welcome:',
});
```

## 3. Show them

```tsx
import { useWorkspace } from '@theclearsky/easy-folder-management-ui/react';
import { FileSidebar, TabStrip } from '@theclearsky/easy-folder-management-ui/ui';
import '@theclearsky/easy-folder-management-ui/styles.css';
```

`npm run playground` renders every component on a bare page.

## License

MIT © 2026 Deepak Prasad
