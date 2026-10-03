import { StrictMode, useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createMemoryStore,
  emptyTabs,
  extensionPolicy,
  FileLibrary,
  parseTabId,
  tabId,
  tabsReducer,
} from '../src/index';
import {
  createToaster,
  EmptyState,
  FileSidebar,
  PanelErrorBoundary,
  RecentList,
  TabStrip,
  Toaster,
  useUnsavedChangesDialog,
  WelcomeAction,
  WelcomeLayout,
  WelcomeSection,
} from '../src/ui/index';

const policy = extensionPolicy({ openable: ['.mp4', '.mkv', '.webm'], content: 'binary' });
const toaster = createToaster();
const WELCOME = tabId('welcome');
const SHARE = tabId('share', 's_9f2c');

const seeded = new WeakMap<FileLibrary, Promise<void>>();

/** Once per library: StrictMode runs effects twice in development. */
function seed(library: FileLibrary): Promise<void> {
  let done = seeded.get(library);
  if (!done) seeded.set(library, (done = seedOnce(library)));
  return done;
}

async function seedOnce(library: FileLibrary) {
  await library.init();
  const root = library.tree.rootId;
  const show = await library.createFolder(root, 'Slime S4');
  for (const n of [1, 2, 3]) await library.createFile(show, `ep0${n}.mkv`, new Uint8Array([n]));
  await library.createFile(show, 'ep01.srt', '1');
  const rezero = await library.createFolder(root, 'Re Zero S3');
  await library.createFile(rezero, 'opening.mp4', new Uint8Array([9]));
  await library.createFile(root, 'nostalgia.mp4', new Uint8Array([7]));
}

function App() {
  const [library] = useState(() => new FileLibrary({ store: createMemoryStore(), policy }));
  const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);
  const [tabs, dispatch] = useReducer(tabsReducer, {
    ...emptyTabs,
    order: [WELCOME],
    active: WELCOME,
    mru: [WELCOME],
  });
  const unsaved = useUnsavedChangesDialog();
  useEffect(() => {
    void seed(library).then(() => {
      const find = (name: string) => Object.values(library.tree.nodes).find((node) => node.name === name)!;
      dispatch({ type: 'open', id: tabId('file', find('ep02.mkv').id) });
      dispatch({ type: 'open', id: SHARE, activate: false });
      dispatch({ type: 'open', id: tabId('file', find('ep03.mkv').id), preview: true, activate: false });
      dispatch({ type: 'activate', id: WELCOME });
    });
  }, [library]);
  const label = (id: string) => {
    const parsed = parseTabId(id)!;
    if (parsed.kind === 'welcome') return 'Welcome';
    if (parsed.kind === 'share') return 'ep02.mkv — Deepak';
    return library.tree.nodes[parsed.key]?.name ?? 'Missing';
  };
  const active = tabs.active ? parseTabId(tabs.active) : null;
  return (
    <Toaster store={toaster}>
      <div style={{ display: 'flex', height: '100vh' }}>
        <PanelErrorBoundary resetKey={snapshot.mode.kind}>
          <FileSidebar
            snapshot={snapshot}
            policy={policy}
            activeFileId={active?.kind === 'file' ? active.key : null}
            readOnly={false}
            canLinkFolders={true}
            previewOnClick
            onOpen={(id, { preview }) => dispatch({ type: 'open', id: tabId('file', id), preview })}
            onLink={() => toaster.show({ message: 'Link folder clicked' })}
            strings={{ title: 'Videos', empty: 'Link a folder of videos' }}
            rowExtras={(node) => (node.name === 'ep01.mkv' ? <span title='watched'>✓</span> : null)}
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
            order={tabs.order}
            active={tabs.active}
            preview={tabs.preview}
            label={label}
            isDirty={(id) => id === tabs.order[1]}
            status={(id) => (id === SHARE ? 'ended' : 'ok')}
            renderIcon={(id) => (parseTabId(id)?.kind === 'share' ? '🔗' : null)}
            onActivate={(id) => dispatch({ type: 'activate', id })}
            onClose={(ids) => dispatch({ type: 'close', ids })}
            onReorder={(id, toIndex) => dispatch({ type: 'reorder', id, toIndex })}
            onPromote={(id) => dispatch({ type: 'promote', id })}
            onCloseOthers={() => {}}
            onCloseAll={() => {}}
            onReopen={() => dispatch({ type: 'reopen', canReopen: () => true })}
            panelId='content'
          />
          <div id='content' role='tabpanel' style={{ flex: 1, minHeight: 0 }}>
            {active?.kind === 'welcome' ? (
              <WelcomeLayout title='▶ watch-together'>
                <WelcomeSection title='Start'>
                  <WelcomeAction onClick={() => {}}>📁 Link a video folder…</WelcomeAction>
                  <WelcomeAction onClick={() => void unsaved.ask(['ep02.mkv'])}>Try the unsaved-changes dialog</WelcomeAction>
                </WelcomeSection>
                <WelcomeSection title='Room'>
                  <WelcomeAction
                    onClick={() =>
                      toaster.show({ message: '📡 Deepak shared ep02.mkv', action: { label: 'Open', run: () => {} } })
                    }
                  >
                    ＋ Create a room
                  </WelcomeAction>
                  <WelcomeAction hint='code or link' onClick={() => {}}>
                    → Join a room
                  </WelcomeAction>
                </WelcomeSection>
                <WelcomeSection title='Recent'>
                  <RecentList entries={[{ id: '1', name: 'ep02.mkv', detail: 'Slime S4' }]} onOpen={() => {}} />
                </WelcomeSection>
              </WelcomeLayout>
            ) : tabs.order.length === 0 ? (
              <EmptyState
                icon='▶'
                rows={[
                  { label: 'Open a video', hint: 'click it in the library ←' },
                  {
                    label: 'Reopen closed tab',
                    hint: 'Alt+Shift+T',
                    onClick: () => dispatch({ type: 'reopen', canReopen: () => true }),
                  },
                ]}
              />
            ) : (
              <ContentPreview label={label(tabs.active!)} kind={active?.kind ?? 'file'} />
            )}
          </div>
        </div>
      </div>
      {unsaved.element}
    </Toaster>
  );
}

/** What an app renders for a tab — the library only decides WHICH tab is
 *  shown. A stand-in "player" so screenshots look like a real app. */
function ContentPreview({ label, kind }: { label: string; kind: string }) {
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
          <div style={{ fontSize: 56, lineHeight: 1, opacity: 0.9 }}>{kind === 'share' ? '📡' : '▶'}</div>
          <div style={{ marginTop: 14, fontSize: 18 }}>{label}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#8a94a6' }}>your app renders the tab here</div>
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
