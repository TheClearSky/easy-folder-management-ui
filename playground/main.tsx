import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  canLinkFolders,
  createIndexedDbStore,
  defineTabKinds,
  extensionPolicy,
  FileLibrary,
  formatBytes,
  parseTabId,
  pickFolder,
  tabId,
  Workspace,
} from '../src/index';
import type { FolderAccess, UnlinkProgress } from '../src/index';
import { useWorkspace } from '../src/react/index';
import {
  accessChoice,
  confirmChoice,
  createToaster,
  EmptyState,
  FileSidebar,
  FolderThemeProvider,
  PanelErrorBoundary,
  TabStrip,
  Toaster,
  unlinkChoice,
  unlinkProgressView,
  useChoiceDialog,
  WelcomeAction,
  WelcomeLayout,
  WelcomeSection,
} from '../src/ui/index';
import { playgroundThemes } from './themes';
import type { PlaygroundThemeName } from './themes';
import './playground.css';

/**
 * Dev page: the components on a bare page, driven by a real Workspace over a
 * persistent library (IndexedDB + OPFS for the videos), so every flow can be
 * tried: link read-only or read & write, switch access from the tag, unlink
 * with KEEP (a streamed copy with progress and Cancel) or REMOVE, and
 * create / rename / move / delete in the in-browser library.
 *
 * "Link the demo folder" builds a folder INSIDE OPFS and links it like a
 * real one, so the flows work without a native picker (and in automation).
 */

const policy = extensionPolicy({ openable: ['.mp4', '.mkv', '.webm'], content: 'binary' });
const kinds = defineTabKinds({ file: { persist: 'file' }, welcome: { persist: 'key' } });
const WELCOME = tabId('welcome');
const STORE_NAME = 'efm-playground.library';
const DEMO_FOLDER = 'efm-playground-demo-folder';
const toaster = createToaster();

type Shown = { name: string; size: number; type: string; url: string } | null;

/** Recorded for the verification script (verification/, not shipped). */
const progressLog: UnlinkProgress[] = [];

async function seed(library: FileLibrary): Promise<boolean> {
  const root = library.tree.rootId;
  const show = await library.createFolder(root, 'Slime S4');
  for (const n of [1, 2, 3]) await library.createFile(show, `ep0${n}.mkv`, new Uint8Array(4096).fill(n));
  await library.createFile(show, 'ep01.srt', '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  await library.createFile(root, 'nostalgia.mp4', new Uint8Array(8192).fill(7));
  return false;
}

/** A folder inside OPFS that looks like a user's video folder. */
async function makeDemoFolder(megabytes: number): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory();
  await opfs.removeEntry(DEMO_FOLDER, { recursive: true }).catch(() => {});
  const root = await opfs.getDirectoryHandle(DEMO_FOLDER, { create: true });
  const write = async (dir: FileSystemDirectoryHandle, name: string, bytes: number, seed: number) => {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    const chunk = new Uint8Array(1024 * 1024);
    for (let offset = 0; offset < bytes; offset += chunk.length) {
      const size = Math.min(chunk.length, bytes - offset);
      for (let i = 0; i < size; i += 1) chunk[i] = ((offset + i) * 31 + seed) & 0xff;
      await writable.write(chunk.subarray(0, size));
    }
    await writable.close();
  };
  const movies = await root.getDirectoryHandle('Movies', { create: true });
  await write(movies, 'big-demo.mp4', megabytes * 1024 * 1024, 1);
  const subs = await (await movies.getFileHandle('big-demo.srt', { create: true })).createWritable();
  await subs.write('1\n00:00:01,000 --> 00:00:02,000\nsubtitle\n');
  await subs.close();
  const season = await (await root.getDirectoryHandle('Shows', { create: true })).getDirectoryHandle('S1', {
    create: true,
  });
  await write(season, 'ep01.mkv', 2 * 1024 * 1024, 2);
  await root.getDirectoryHandle('Empty folder', { create: true });
  return root;
}

function initialTheme(): PlaygroundThemeName {
  const requested = new URLSearchParams(location.search).get('theme');
  return requested === 'light' || requested === 'warm' ? requested : 'default';
}

/** Playground chrome, not the library: a floating theme picker (`?theme=` in
 *  the URL too). Inline styles, so it carries no `efm:` class. */
function ThemeSwitcher({ value, onChange }: { value: PlaygroundThemeName; onChange(name: PlaygroundThemeName): void }) {
  return (
    <label
      data-theme-switcher
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 12,
        transform: 'translateX(-50%)',
        zIndex: 2000,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '4px 8px',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.55)',
        color: '#fff',
        font: '12px system-ui, sans-serif',
      }}
    >
      Theme
      <select value={value} onChange={(event) => onChange(event.target.value as PlaygroundThemeName)}>
        <option value='default'>default</option>
        <option value='light'>light (preset)</option>
        <option value='warm'>warm (custom)</option>
      </select>
    </label>
  );
}

function App() {
  const [themeName, setThemeName] = useState<PlaygroundThemeName>(initialTheme);
  const chooseTheme = (name: PlaygroundThemeName) => {
    setThemeName(name);
    const url = new URL(location.href);
    url.searchParams.set('theme', name);
    history.replaceState(null, '', url);
  };
  return (
    <FolderThemeProvider {...playgroundThemes[themeName]}>
      <Playground />
      <ThemeSwitcher value={themeName} onChange={chooseTheme} />
    </FolderThemeProvider>
  );
}

function Playground() {
  const dialog = useChoiceDialog();
  const [shown, setShown] = useState<Shown>(null);
  const [renameRequest, setRenameRequest] = useState<string | null>(null);
  const { workspace, snapshot } = useWorkspace(() => {
    const library = new FileLibrary({ store: createIndexedDbStore(STORE_NAME), policy, access: 'read' });
    return new Workspace<File>({
      library,
      kinds,
      welcomeTab: WELCOME,
      documents: {
        // Disk-backed (a linked file, or an OPFS copy): nothing is read here.
        load: async (file) => ({ ok: true, content: await file.getFile() }),
        install: (file) =>
          setShown((previous) => {
            if (previous) URL.revokeObjectURL(previous.url);
            return { name: file.name, size: file.size, type: file.type, url: URL.createObjectURL(file) };
          }),
        closeEditor: () => setShown(null),
      },
      confirm: async (request) => (await dialog.ask(confirmChoice(request))) === 'confirm',
      chooseUnlink: (plan) => dialog.ask(unlinkChoice(plan)),
      startup: { migrateFirstVisit: () => seed(library) },
    });
  });
  const library = workspace.library;

  useEffect(() => {
    Object.assign(window, { __efm: { workspace, library, makeDemoFolder, progressLog, dialog } });
  });

  /** Ask the mode first — the click on a choice is a fresh user gesture for
   *  the picker that follows. */
  const linkWith = async (pick: (access: FolderAccess) => Promise<FileSystemDirectoryHandle | null>) => {
    const access = await dialog.ask(accessChoice());
    if (access === 'cancel') return;
    const folder = await pick(access);
    if (folder) await workspace.link(folder, { access });
  };
  const linkDemo = () => {
    const megabytes = Number(new URLSearchParams(location.search).get('demoMB') ?? 64);
    void linkWith(async () => {
      dialog.showProgress({ title: `Building a ${megabytes} MB demo folder in OPFS…`, value: null });
      try {
        return await makeDemoFolder(megabytes);
      } finally {
        dialog.showProgress(null);
      }
    });
  };
  const unlink = () => {
    progressLog.length = 0;
    void workspace
      .unlink({
        onProgress: (progress) => {
          progressLog.push(progress);
          dialog.showProgress(unlinkProgressView(progress, () => workspace.cancelUnlink()));
        },
      })
      .finally(() => dialog.showProgress(null));
  };
  const reset = async () => {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(STORE_NAME);
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
    const opfs = await navigator.storage.getDirectory();
    for (const name of [`${STORE_NAME}.blobs`, DEMO_FOLDER]) {
      await opfs.removeEntry(name, { recursive: true }).catch(() => {});
    }
    location.reload();
  };

  const active = snapshot.tabs.active ? parseTabId(snapshot.tabs.active) : null;
  return (
    <Toaster store={toaster}>
      <div style={{ display: 'flex', height: '100vh' }}>
        <PanelErrorBoundary resetKey={snapshot.library.mode.kind}>
          <FileSidebar
            snapshot={snapshot.library}
            policy={policy}
            activeFileId={snapshot.activeFileId}
            readOnly={snapshot.readOnly}
            folderActionsDisabled={snapshot.folderActionsDisabled}
            canLinkFolders={canLinkFolders()}
            previewOnClick
            onOpen={(id, { preview }) => void workspace.openFile(id, { preview })}
            onNewFolder={(parent) =>
              void library.createFolder(parent, 'New folder').then(setRenameRequest, () => {})
            }
            renameRequest={renameRequest}
            onRenameRequestHandled={() => setRenameRequest(null)}
            onRename={(id, name) => void workspace.rename(id, name)}
            onMove={(ids, target) => void workspace.move(ids, target)}
            onDelete={(ids) => void workspace.remove(ids)}
            onUndoDelete={() => void workspace.undoDelete()}
            onLink={() => void linkWith((access) => pickFolder({ access, id: 'efm-playground' }))}
            onUnlink={unlink}
            onReconnect={(access) => void workspace.reconnect({ access })}
            onChangeAccess={(access) => void workspace.setFolderAccess(access)}
            onDismissError={() => library.dismissError()}
            onDismissNotice={() => library.dismissNotice()}
            strings={{ title: 'Videos', empty: 'Link a folder of videos' }}
            contextActions={(ids) => [
              {
                id: 'share',
                label: 'Share to room',
                disabled: ids.length !== 1,
                onSelect: () => toaster.show({ message: 'Share clicked' }),
              },
            ]}
          />
        </PanelErrorBoundary>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <TabStrip
            order={snapshot.tabs.order}
            active={snapshot.tabs.active}
            preview={snapshot.tabs.preview}
            label={(id) => workspace.label(id)}
            isDirty={(id) => workspace.isDirty(id)}
            status={(id) => (workspace.isTabMissing(id) ? 'missing' : 'ok')}
            onActivate={(id) => void workspace.activateTab(id)}
            onClose={(ids) => void workspace.closeTabs(ids)}
            onReorder={(id, toIndex) => workspace.reorderTab(id, toIndex)}
            onPromote={(id) => workspace.promoteTab(id)}
            onReopen={() => void workspace.reopenClosedTab()}
            panelId='content'
          />
          <div id='content' role='tabpanel' style={{ flex: 1, minHeight: 0 }}>
            {active?.kind === 'welcome' ? (
              <WelcomeLayout title='▶ easy-folder-management-ui'>
                <WelcomeSection title='Folders'>
                  <WelcomeAction onClick={() => void linkWith((access) => pickFolder({ access, id: 'efm-playground' }))}>
                    📁 Link a folder…
                  </WelcomeAction>
                  <WelcomeAction hint='built in OPFS, no picker' onClick={linkDemo}>
                    🧪 Link the demo folder
                  </WelcomeAction>
                </WelcomeSection>
                <WelcomeSection title='Playground'>
                  <WelcomeAction hint='IndexedDB + OPFS' onClick={() => void reset()}>
                    ↺ Reset everything
                  </WelcomeAction>
                </WelcomeSection>
              </WelcomeLayout>
            ) : snapshot.tabs.order.length === 0 || !shown ? (
              <EmptyState icon='▶' rows={[{ label: 'Open a video', hint: 'click it in the library ←' }]} />
            ) : (
              <ContentPreview shown={shown} />
            )}
          </div>
        </div>
      </div>
      {dialog.element}
    </Toaster>
  );
}

/** What an app renders for a file tab: here a player over the disk-backed
 *  File (a linked file, or its OPFS copy after KEEP). */
function ContentPreview({ shown }: { shown: NonNullable<Shown> }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#111' }}>
      <div
        style={{
          flex: 1,
          margin: 24,
          borderRadius: 10,
          display: 'grid',
          placeItems: 'center',
          background: 'radial-gradient(circle at 30% 25%, #2b4a7a 0%, #1a2238 45%, #0d0f16 100%)',
          boxShadow: 'inset 0 0 0 1px #2a2f3a',
        }}
      >
        <div style={{ textAlign: 'center', color: '#e6e6e6' }}>
          <video src={shown.url} controls style={{ maxWidth: 480, maxHeight: 240, background: '#000' }} />
          <div data-testid='shown-name' style={{ marginTop: 14, fontSize: 18 }}>
            {shown.name}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#8a94a6' }}>
            {formatBytes(shown.size)} · {shown.type || 'unknown type'}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
