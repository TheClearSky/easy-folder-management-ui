import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

/**
 * A tiny toast system, ported from Nodestra (its ruling L6: our own, no
 * dependency). One change: the store is an INSTANCE (`createToaster`), not
 * module state, so two copies of the package (ESM + CJS, or two versions) can
 * never split one app's toasts between two stores.
 *
 * A toast's countdown only runs while its `<Toaster>` is shown (`paused`
 * holds it), so a message raised while the app is covered is still there to
 * read.
 */

type ToastAction = { label: string; run(): void };
type Toast = { id: number; message: ReactNode; action?: ToastAction; timeoutMs: number };
type ToastInput = { message: ReactNode; action?: ToastAction; timeoutMs?: number };

interface ToastStore {
  show(toast: ToastInput): number;
  dismiss(id: number): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly Toast[];
}

function createToaster(): ToastStore {
  let toasts: readonly Toast[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = (next: readonly Toast[]) => {
    toasts = next;
    for (const listener of listeners) listener();
  };
  return {
    show(toast) {
      const id = nextId++;
      emit([...toasts, { id, message: toast.message, action: toast.action, timeoutMs: toast.timeoutMs ?? 8000 }]);
      return id;
    },
    dismiss(id) {
      emit(toasts.filter((toast) => toast.id !== id));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => toasts,
  };
}

const ToasterContext = createContext<ToastStore | null>(null);

/** The store of the nearest `<Toaster>`; throws outside one. */
function useToaster(): ToastStore {
  const store = useContext(ToasterContext);
  if (!store) throw new Error('useToaster() needs a <Toaster store={…}> above it.');
  return store;
}

function ToastItem({ store, toast, paused }: { store: ToastStore; toast: Toast; paused: boolean }) {
  useEffect(() => {
    if (paused) return;
    const handle = window.setTimeout(() => store.dismiss(toast.id), toast.timeoutMs);
    return () => window.clearTimeout(handle);
  }, [store, toast, paused]);
  return (
    <div
      role='status'
      className='efm:pointer-events-auto efm:flex efm:max-w-[420px] efm:items-center efm:gap-3 efm:rounded-md efm:border efm:border-border efm:bg-surface-raised efm:px-3 efm:py-2 efm:text-[13px] efm:text-fg efm:shadow-lg'
    >
      <span className='efm:min-w-0 efm:flex-1'>{toast.message}</span>
      {toast.action && (
        <button
          type='button'
          className='efm:cursor-pointer efm:rounded efm:px-2 efm:py-0.5 efm:text-[12px] efm:font-semibold efm:text-accent efm:hover:bg-hover'
          onClick={() => {
            toast.action?.run();
            store.dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type='button'
        aria-label='Dismiss'
        className='efm:cursor-pointer efm:rounded efm:px-1 efm:text-fg-muted efm:hover:bg-hover efm:hover:text-fg'
        onClick={() => store.dismiss(toast.id)}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Bottom-right stack, and the provider `useToaster()` reads. Children (if
 * any) are rendered inside the provider. Each toast is its own `role=status`
 * region, so the container itself carries no `aria-live` (two live regions
 * announced every toast twice in Nodestra).
 */
function Toaster({ store, paused = false, children }: { store: ToastStore; paused?: boolean; children?: ReactNode }) {
  const current = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <ToasterContext.Provider value={store}>
      {children}
      {current.length > 0 && (
        <div
          data-efm='toaster'
          className='efm:pointer-events-none efm:fixed efm:right-4 efm:bottom-4 efm:z-900 efm:flex efm:flex-col efm:items-end efm:gap-2'
        >
          {current.map((toast) => (
            <ToastItem key={toast.id} store={store} toast={toast} paused={paused} />
          ))}
        </div>
      )}
    </ToasterContext.Provider>
  );
}

export { createToaster, Toaster, useToaster };
export type { Toast, ToastAction, ToastInput, ToastStore };
