/**
 * The tab record: kinds, paths, legacy records. The first three cases are
 * the library's original tab tests (from Nodestra), with ids now `kind:key`.
 */

import { describe, expect, it } from 'vitest';
import { FileLibrary } from '../core/fileLibrary';
import { createMemoryStore } from '../core/keyValueStore';
import { findByPath } from '../core/libraryTree';
import { extensionPolicy } from '../core/policy';
import { defineTabKinds, parseTabId, tabId } from '../core/tabKinds';
import { createTabRecordStore } from '../core/tabRecord';

const policy = extensionPolicy({ openable: ['.json'], content: 'text', defaultExtension: '.json' });
const kinds = defineTabKinds({
  file: { persist: 'file' },
  welcome: { persist: 'key', legacyIds: ['@welcome'] },
  share: { persist: false },
});
const file = (id: string) => tabId('file', id);
const WELCOME = tabId('welcome');

async function fresh() {
  const store = createMemoryStore();
  const library = new FileLibrary({ store, policy });
  await library.init();
  return { library, store, tabs: createTabRecordStore({ library, kinds }) };
}

async function reload(store: ReturnType<typeof createMemoryStore>) {
  const library = new FileLibrary({ store, policy });
  await library.init();
  return { library, tabs: createTabRecordStore({ library, kinds }) };
}

describe('tab ids', () => {
  it('round-trip, keys may contain the separator', () => {
    expect(tabId('file', 'abc')).toBe('file:abc');
    expect(parseTabId('share:peer:1')).toEqual({ kind: 'share', key: 'peer:1' });
    expect(parseTabId(WELCOME)).toEqual({ kind: 'welcome', key: '' });
    expect(parseTabId('@welcome')).toBeNull();
    expect(() => tabId('a:b')).toThrow();
  });

  it('only one kind may persist files by path', () => {
    expect(() => defineTabKinds({ a: { persist: 'file' }, b: { persist: 'file' } })).toThrow('Only one');
  });
});

describe('tab record', () => {
  it('remembers open tabs by path: renames follow, deleted files drop out', async () => {
    const { library, store, tabs } = await fresh();
    const folder = await library.createFolder(library.tree.rootId, 'drums');
    const kick = await library.createFile(folder, 'kick.json', 'K');
    const snare = await library.createFile(library.tree.rootId, 'snare.json', 'S');
    const gone = await library.createFile(library.tree.rootId, 'gone.json', 'G');
    const record = { order: [file(kick), WELCOME, file(snare), file(gone)], active: file(snare), closed: [file(gone)] };
    await tabs.remember(record);
    await library.rename(folder, 'percussion');
    await tabs.remember(record);
    await library.remove([gone]);

    const reloaded = await reload(store);
    const recalled = await reloaded.tabs.recall();
    expect(recalled?.order).toEqual([
      file(findByPath(reloaded.library.tree, ['percussion', 'kick.json'])!.id),
      WELCOME,
      file(snare),
    ]);
    expect(recalled?.active).toBe(file(snare));
    expect(recalled?.closed).toEqual([]);
  });

  it('a library from before tabs brings back its single open file as one tab', async () => {
    const { library, store } = await fresh();
    const id = await library.createFile(library.tree.rootId, 'a.json', '');
    await store.set('activeFile', ['a.json']); // the legacy key, as Nodestra wrote it
    const reloaded = await reload(store);
    expect(await reloaded.tabs.recall()).toEqual({
      order: [file(id)],
      active: file(id),
      closed: [],
      recent: [file(id)],
      preview: null,
    });
  });

  it("reads Nodestra's stored record format unchanged", async () => {
    const { library, store } = await fresh();
    const folder = await library.createFolder(library.tree.rootId, 'Demos');
    const piano = await library.createFile(folder, 'Piano.json', '{}');
    // Captured shape of a real Nodestra `openTabs` record (graphLibrary.ts
    // rememberTabs): files by path, the Welcome page as {page:'@welcome'}.
    await store.set('openTabs', {
      order: [{ page: '@welcome' }, { path: ['Demos', 'Piano.json'] }],
      active: { path: ['Demos', 'Piano.json'] },
      closed: [{ page: '@welcome' }],
      recent: [{ path: ['Demos', 'Piano.json'] }, { page: '@welcome' }],
    });
    const reloaded = await reload(store);
    expect(await reloaded.tabs.recall()).toEqual({
      order: [WELCOME, file(piano)],
      active: file(piano),
      closed: [],
      recent: [file(piano)],
      preview: null,
    });
  });

  it('never writes non-persistent kinds, and keeps the preview tab', async () => {
    const { library, store, tabs } = await fresh();
    const a = await library.createFile(library.tree.rootId, 'a.json', '');
    const b = await library.createFile(library.tree.rootId, 'b.json', '');
    await tabs.remember({
      order: [file(a), tabId('share', 's_9f2c'), file(b)],
      active: tabId('share', 's_9f2c'),
      closed: [],
      recent: [file(b), file(a)],
      preview: file(b),
    });
    const recalled = await (await reload(store)).tabs.recall();
    expect(recalled).toEqual({
      order: [file(a), file(b)],
      active: file(a), // the active share tab is gone; first tab wins
      closed: [],
      recent: [file(b), file(a)],
      preview: file(b),
    });
  });

  it('drops files the policy no longer opens', async () => {
    const { library, store, tabs } = await fresh();
    const notes = await library.createFile(library.tree.rootId, 'notes.txt', '');
    await tabs.remember({ order: [file(notes)], active: file(notes) });
    expect((await (await reload(store)).tabs.recall())?.order).toEqual([]);
  });
});
