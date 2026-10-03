import { describe, expect, it } from 'vitest';
import {
  activeAfterClose,
  emptyTabs,
  othersOf,
  rightOf,
  sanitizeTabs,
  tabsReducer,
} from '../core/tabsModel';
import type { TabsAction, TabsState } from '../core/tabsModel';

const run = (state: TabsState, ...actions: TabsAction[]) => actions.reduce(tabsReducer, state);
const open = (id: string, activate = true): TabsAction => ({ type: 'open', id, activate });

describe('tabsModel', () => {
  it('opens tabs after the active one and activates them', () => {
    const state = run(emptyTabs, open('a'), open('b'), { type: 'activate', id: 'a' }, open('c'));
    expect(state.order).toEqual(['a', 'c', 'b']);
    expect(state.active).toBe('c');
    expect(state.mru).toEqual(['c', 'a', 'b']);
  });

  it('re-opening an open tab only focuses it (no duplicates)', () => {
    const state = run(emptyTabs, open('a'), open('b'), open('a'));
    expect(state.order).toEqual(['a', 'b']);
    expect(state.active).toBe('a');
  });

  it('opening in the background keeps the active tab', () => {
    const state = run(emptyTabs, open('a'), open('b', false));
    expect(state.active).toBe('a');
    expect(state.order).toEqual(['a', 'b']);
  });

  it('closing the active tab focuses the most recently used one, not a neighbour', () => {
    // Used order: a, then c, then b → close b → c (last used), even though a is adjacent.
    let state = run(emptyTabs, open('a'), open('b'), open('c'));
    state = run(state, { type: 'activate', id: 'a' }, { type: 'activate', id: 'c' }, { type: 'activate', id: 'b' });
    expect(activeAfterClose(state, ['b'])).toBe('c');
    state = run(state, { type: 'close', ids: ['b'] });
    expect(state.active).toBe('c');
    expect(state.order).toEqual(['a', 'c']);
  });

  it('closing the last tab leaves nothing open', () => {
    const state = run(emptyTabs, open('a'), { type: 'close', ids: ['a'] });
    expect(state).toMatchObject({ order: [], active: null, mru: [] });
  });

  it('reopens closed tabs most-recent first, skipping ones that no longer exist', () => {
    let state = run(emptyTabs, open('a'), open('b'), open('c'));
    state = run(state, { type: 'close', ids: ['b'] }, { type: 'close', ids: ['c'] });
    expect(state.closed).toEqual(['c', 'b']);
    state = tabsReducer(state, { type: 'reopen', canReopen: (id) => id !== 'c' });
    expect(state.order).toContain('b');
    expect(state.active).toBe('b');
    expect(state.closed).toEqual(['c']);
  });

  it('close-family helpers', () => {
    const state = run(emptyTabs, open('a'), open('b'), open('c'), open('d'));
    expect(othersOf(state, 'b')).toEqual(['a', 'c', 'd']);
    expect(rightOf(state, 'b')).toEqual(['c', 'd']);
    const afterRight = tabsReducer(state, { type: 'close', ids: rightOf(state, 'b') });
    expect(afterRight.order).toEqual(['a', 'b']);
    expect(afterRight.active).toBe('b');
  });

  it('reorders within bounds', () => {
    const state = run(emptyTabs, open('a'), open('b'), open('c'));
    expect(tabsReducer(state, { type: 'reorder', id: 'a', toIndex: 2 }).order).toEqual(['b', 'c', 'a']);
    expect(tabsReducer(state, { type: 'reorder', id: 'c', toIndex: -5 }).order).toEqual(['c', 'a', 'b']);
    expect(tabsReducer(state, { type: 'reorder', id: 'b', toIndex: 1 })).toBe(state);
  });

  it('retain drops gone tabs and forgets them for reopen', () => {
    let state = run(emptyTabs, open('a'), open('b'), open('c'), { type: 'close', ids: ['c'] });
    state = tabsReducer(state, { type: 'retain', keep: (id) => id === 'a' });
    expect(state.order).toEqual(['a']);
    expect(state.active).toBe('a');
    expect(state.closed).toEqual([]);
  });

  it('sanitizes a damaged stored record', () => {
    const repaired = sanitizeTabs({
      order: ['a', 'b', 'a'],
      active: 'zz',
      mru: ['q', 'b'],
      closed: ['a', 'x', 'x'],
    });
    expect(repaired).toEqual({ order: ['a', 'b'], active: 'a', mru: ['a', 'b'], closed: ['x'], preview: null });
  });
});

describe('tabsModel — preview tabs', () => {
  const preview = (id: string): TabsAction => ({ type: 'open', id, preview: true });

  it('a preview open replaces the previous preview in its slot', () => {
    const state = run(emptyTabs, open('a'), preview('p1'), open('b'), { type: 'activate', id: 'p1' }, preview('p2'));
    expect(state.order).toEqual(['a', 'p2', 'b']);
    expect(state.preview).toBe('p2');
    expect(state.active).toBe('p2');
    expect(state.mru).not.toContain('p1');
    expect(state.closed).not.toContain('p1');
  });

  it('a permanent open, or promote, keeps the preview tab', () => {
    let state = run(emptyTabs, preview('p'));
    expect(run(state, open('p')).preview).toBeNull();
    state = run(state, { type: 'promote', id: 'p' });
    expect(state.preview).toBeNull();
    expect(run(state, preview('q')).order).toEqual(['p', 'q']);
  });

  it('a preview open of a permanent tab never demotes it', () => {
    const state = run(emptyTabs, open('a'), open('b'), preview('a'));
    expect(state.preview).toBeNull();
    expect(state.active).toBe('a');
  });

  it('closing the preview tab clears the slot', () => {
    const state = run(emptyTabs, open('a'), preview('p'), { type: 'close', ids: ['p'] });
    expect(state.preview).toBeNull();
    expect(state.active).toBe('a');
  });

  it('without preview opens nothing changes (Nodestra)', () => {
    const state = run(emptyTabs, open('a'), open('b'), open('c'));
    expect(state.preview).toBeNull();
    expect(state.order).toEqual(['a', 'b', 'c']);
  });
});
