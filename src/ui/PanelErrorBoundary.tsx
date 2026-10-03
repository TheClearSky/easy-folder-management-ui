import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { cn } from './cn';

type Props = {
  children: ReactNode;
  /** When this changes (e.g. the library switches mode), a crashed panel
   *  gets a fresh try on its own — no dead "Try again" after a link. */
  resetKey?: string;
  /** Shown above the error message. */
  title?: string;
  /** Called with every caught error (observability: the app decides where
   *  it goes). Default: `console.error`. */
  onError?(error: Error, info: ErrorInfo): void;
  className?: string;
};
type State = { error: Error | null };

/**
 * Keeps a failure in one panel (the sidebar) inside that panel. Without it
 * an exception while rendering the tree unmounted Nodestra's whole React
 * root, editor included — a far worse outcome than a broken panel.
 */
class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError) this.props.onError(error, info);
    else console.error('[easy-folder-management-ui] panel crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <aside
        data-efm='panel-error'
        className={cn(
          'efm:flex efm:h-full efm:w-[260px] efm:flex-none efm:flex-col efm:gap-2 efm:border-r efm:border-border efm:bg-surface efm:p-3 efm:text-[12px] efm:text-fg-muted',
          this.props.className,
        )}
      >
        <p className='efm:text-fg'>{this.props.title ?? 'This panel hit an error.'}</p>
        <p className='efm:break-words'>{this.state.error.message}</p>
        <button
          type='button'
          className='efm:cursor-pointer efm:self-start efm:rounded efm:border efm:border-control efm:bg-surface-raised efm:px-2 efm:py-1 efm:text-fg efm:hover:bg-hover'
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </aside>
    );
  }
}

export { PanelErrorBoundary };
