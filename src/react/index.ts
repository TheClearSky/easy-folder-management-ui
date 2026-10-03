// React bindings for the framework-free core: each store already speaks
// `subscribe` / `getSnapshot`, so a hook is `useSyncExternalStore` plus a
// stable instance.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FileLibrary, LibrarySnapshot } from '../core/fileLibrary';
import type { Workspace, WorkspaceSnapshot } from '../core/workspace';

/** The library's current snapshot; re-renders on every change. */
function useLibrarySnapshot(library: FileLibrary): LibrarySnapshot {
  return useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
}

/**
 * Create a workspace ONCE for the component's lifetime, boot it, and follow
 * its snapshot.
 *
 * The instance is made with `useState(() => …)`, never `useMemo`: React may
 * discard a memo (and Fast Refresh re-runs it), which in Nodestra re-minted
 * its stores mid-session — "Loading…" forever and an emptied timeline.
 *
 * It is NOT disposed on unmount: StrictMode's rehearsal unmount would tear
 * down a workspace that is then used again. A workspace lives as long as the
 * app; call `workspace.dispose()` yourself if you really drop one.
 */
function useWorkspace<Content, Snapshot>(
  create: () => Workspace<Content, Snapshot>,
): { workspace: Workspace<Content, Snapshot>; snapshot: WorkspaceSnapshot } {
  const [workspace] = useState(create);
  useEffect(() => {
    void workspace.boot(); // idempotent
  }, [workspace]);
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
  return { workspace, snapshot };
}

export { useLibrarySnapshot, useWorkspace };
