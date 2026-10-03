/**
 * The open tabs, as plain data and a pure reducer — no React, no I/O.
 *
 * Tabs are opaque ids (`"file:<node id>"`, `"welcome:"` — see tabKinds.ts);
 * a file tab is keyed by the file's STABLE library id, so a rename or a move
 * in the library needs nothing here: the label is looked up at render time.
 * This module only decides WHICH tab is where and which is active; what
 * showing a tab involves is the workspace's job.
 *
 * PREVIEW TABS (VS Code's italic tab) are opt-in per open: `open` with
 * `preview: true` reuses the current preview tab's slot instead of adding
 * one, so browsing a folder does not flood the strip. Any permanent open of
 * the same tab, or `promote`, makes it a normal tab. Apps that never pass
 * `preview` get exactly the old behaviour (Nodestra ruled no previews, Q4).
 */

type TabsState = {
  /** Left-to-right order of the strip. */
  order: readonly string[];
  /** The tab the editor shows; `null` = nothing open. */
  active: string | null;
  /** Most-recently-used first — who becomes active when the active tab
   *  closes (VS Code focuses the last-used tab, not a neighbour). */
  mru: readonly string[];
  /** Closed tabs, most recent first, for "reopen closed tab". */
  closed: readonly string[];
  /** The preview tab (shown in italics; the next preview open replaces it). */
  preview: string | null;
};

type TabsAction =
  /** Open (or re-focus) a tab. New tabs go right after the active one.
   *  `preview` opens it in the preview slot (replacing the previous preview). */
  | { type: 'open'; id: string; activate?: boolean; preview?: boolean }
  /** Make the preview tab permanent (an edit, a double-click). */
  | { type: 'promote'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'close'; ids: readonly string[] }
  /** Move a tab to a new index in the strip. */
  | { type: 'reorder'; id: string; toIndex: number }
  /** Pop the most recently closed tab that `canReopen` still allows. */
  | { type: 'reopen'; canReopen: (id: string) => boolean }
  /** Drop tabs whose files no longer exist at all (e.g. a new folder was
   *  linked: every old id is gone). Missing-but-maybe-returning files are
   *  NOT pruned here — the strip shows them as "deleted" until closed. */
  | { type: 'retain'; keep: (id: string) => boolean }
  /** Replace everything (restoring a saved record). */
  | { type: 'restore'; state: Omit<TabsState, 'preview'> & { preview?: string | null } };

const MAX_CLOSED = 20;

const emptyTabs: TabsState = { order: [], active: null, mru: [], closed: [], preview: null };

function touch(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((other) => other !== id)];
}

/** Who is active after `closing` leaves: the most recently used survivor. */
function nextActive(state: TabsState, closing: ReadonlySet<string>): string | null {
  if (state.active !== null && !closing.has(state.active)) return state.active;
  return state.mru.find((id) => !closing.has(id) && state.order.includes(id)) ?? null;
}

function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open': {
      const activate = action.activate ?? true;
      if (state.order.includes(action.id)) {
        // A permanent open of the preview tab keeps it; a preview open of a
        // permanent tab never demotes it.
        const kept = !action.preview && state.preview === action.id
          ? { ...state, preview: null }
          : state;
        return activate ? tabsReducer(kept, { type: 'activate', id: action.id }) : kept;
      }
      // A preview open takes the old preview's place (and forgets it: it was
      // never really "opened", so it is not reopenable either).
      const replacing = action.preview && state.preview !== null ? state.preview : null;
      const base = replacing === null
        ? state
        : {
            ...state,
            order: state.order.filter((id) => id !== replacing),
            mru: state.mru.filter((id) => id !== replacing),
            active: state.active === replacing ? null : state.active,
          };
      const at = replacing !== null
        ? state.order.indexOf(replacing)
        : base.active === null ? base.order.length : base.order.indexOf(base.active) + 1;
      const order = [...base.order.slice(0, at), action.id, ...base.order.slice(at)];
      const active = activate ? action.id : (base.active ?? (replacing !== null ? action.id : null));
      return {
        order,
        active,
        mru: active === action.id ? touch(base.mru, action.id) : [...base.mru, action.id],
        closed: state.closed.filter((id) => id !== action.id),
        preview: action.preview ? action.id : replacing === null ? state.preview : null,
      };
    }
    case 'promote': {
      return state.preview === action.id ? { ...state, preview: null } : state;
    }
    case 'activate': {
      if (!state.order.includes(action.id) || state.active === action.id) return state;
      return { ...state, active: action.id, mru: touch(state.mru, action.id) };
    }
    case 'close': {
      const closing = new Set(action.ids.filter((id) => state.order.includes(id)));
      if (closing.size === 0) return state;
      // Remember in strip order, the rightmost first, so repeated "reopen"
      // brings them back in a natural order.
      const reopenable = state.order.filter((id) => closing.has(id)).reverse();
      return {
        order: state.order.filter((id) => !closing.has(id)),
        active: nextActive(state, closing),
        mru: state.mru.filter((id) => !closing.has(id)),
        closed: [...reopenable, ...state.closed.filter((id) => !closing.has(id))].slice(0, MAX_CLOSED),
        preview: state.preview !== null && closing.has(state.preview) ? null : state.preview,
      };
    }
    case 'reorder': {
      const from = state.order.indexOf(action.id);
      if (from < 0) return state;
      const without = state.order.filter((id) => id !== action.id);
      const to = Math.max(0, Math.min(action.toIndex, without.length));
      if (to === from) return state;
      return { ...state, order: [...without.slice(0, to), action.id, ...without.slice(to)] };
    }
    case 'reopen': {
      const index = state.closed.findIndex((id) => action.canReopen(id) && !state.order.includes(id));
      if (index < 0) return state;
      const id = state.closed[index];
      const reopened = tabsReducer(
        { ...state, closed: state.closed.filter((_, i) => i !== index) },
        { type: 'open', id },
      );
      return reopened;
    }
    case 'retain': {
      const gone = state.order.filter((id) => !action.keep(id));
      const afterClose = gone.length > 0 ? tabsReducer(state, { type: 'close', ids: gone }) : state;
      // Gone for good: they are not reopenable either.
      const closed = afterClose.closed.filter((id) => action.keep(id));
      return closed.length === afterClose.closed.length ? afterClose : { ...afterClose, closed };
    }
    case 'restore':
      return sanitizeTabs(action.state);
  }
}

/** Repair a record from storage: dedupe, drop unknown MRU/closed entries,
 *  and make sure `active` (and `preview`) are open tabs. */
function sanitizeTabs(input: Omit<TabsState, 'preview'> & { preview?: string | null }): TabsState {
  const order = [...new Set(input.order)];
  const inOrder = new Set(order);
  const active = input.active !== null && inOrder.has(input.active) ? input.active : (order[0] ?? null);
  const mru = [...new Set(input.mru)].filter((id) => inOrder.has(id));
  for (const id of order) if (!mru.includes(id)) mru.push(id);
  if (active !== null) mru.splice(0, mru.length, ...touch(mru, active));
  const closed = [...new Set(input.closed)].filter((id) => !inOrder.has(id)).slice(0, MAX_CLOSED);
  const preview = input.preview != null && inOrder.has(input.preview) ? input.preview : null;
  return { order, active, mru, closed, preview };
}

/** The tab that ends up active if these close — for callers that must act
 *  on the switch before the state changes (saving, swapping the editor). */
function activeAfterClose(state: TabsState, ids: readonly string[]): string | null {
  return nextActive(state, new Set(ids));
}

/** Close-family helpers: which ids each menu command closes. */
function othersOf(state: TabsState, id: string): string[] {
  return state.order.filter((other) => other !== id);
}
function rightOf(state: TabsState, id: string): string[] {
  const index = state.order.indexOf(id);
  return index < 0 ? [] : state.order.slice(index + 1);
}

export {
  activeAfterClose,
  emptyTabs,
  othersOf,
  rightOf,
  sanitizeTabs,
  tabsReducer,
};
export type { TabsAction, TabsState };
