import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * Building blocks for a Welcome page and a "nothing is open" view — layout
 * only; the app supplies the content (Nodestra: demos, tutorials, a piano;
 * watch-together: rooms). From Nodestra's WelcomePage/EmptyEditor, which were
 * ~20% generic: these are that 20%.
 */

function WelcomeLayout({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div
      data-efm='welcome'
      className={cn('efm:h-full efm:overflow-auto efm:bg-surface-sunken efm:px-10 efm:py-8 efm:text-fg', className)}
    >
      <div className='efm:mx-auto efm:flex efm:max-w-[920px] efm:flex-col efm:gap-8'>
        <h1 className='efm:flex efm:items-center efm:gap-3 efm:text-[26px] efm:font-light'>{title}</h1>
        <div className='efm:grid efm:grid-cols-1 efm:gap-8 efm:md:grid-cols-2'>{children}</div>
      </div>
    </div>
  );
}

function WelcomeSection({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={cn('efm:flex efm:flex-col efm:gap-1.5', wide && 'efm:md:col-span-2')}>
      <h2 className='efm:mb-1 efm:text-[11px] efm:font-semibold efm:tracking-[0.12em] efm:text-fg-muted efm:uppercase'>
        {title}
      </h2>
      {children}
    </section>
  );
}

const ACTION =
  'efm:flex efm:w-full efm:cursor-pointer efm:items-center efm:gap-2 efm:rounded efm:px-2 efm:py-1 efm:text-left efm:text-[13px] efm:text-accent efm:hover:bg-surface-raised efm:disabled:cursor-default efm:disabled:opacity-40 efm:disabled:hover:bg-transparent';

function WelcomeAction({
  children,
  hint,
  disabled,
  onClick,
}: {
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button type='button' className={ACTION} disabled={disabled} onClick={onClick}>
      <span className='efm:min-w-0 efm:flex-1 efm:truncate'>{children}</span>
      {hint !== undefined && <span className='efm:flex-none efm:text-[12px] efm:text-fg-muted'>{hint}</span>}
    </button>
  );
}

type RecentEntry = { id: string; name: string; detail?: string };

function RecentList({
  entries,
  empty = 'Nothing opened yet.',
  onOpen,
}: {
  entries: readonly RecentEntry[];
  empty?: string;
  onOpen(id: string): void;
}) {
  if (entries.length === 0) return <p className='efm:px-2 efm:text-[12px] efm:text-fg-muted'>{empty}</p>;
  return (
    <>
      {entries.map((entry) => (
        <WelcomeAction key={entry.id} hint={entry.detail} onClick={() => onOpen(entry.id)}>
          {entry.name}
        </WelcomeAction>
      ))}
    </>
  );
}

type EmptyStateRow = { label: ReactNode; hint?: ReactNode; onClick?(): void };

/** What the content area shows when nothing is open: a light watermark of
 *  what to do next. */
function EmptyState({
  icon,
  title = 'Nothing is open',
  rows,
  className,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  rows: readonly EmptyStateRow[];
  className?: string;
}) {
  const row = 'efm:flex efm:w-full efm:items-center efm:justify-between efm:gap-8 efm:text-[13px]';
  return (
    <div
      data-efm='empty-state'
      className={cn(
        'efm:flex efm:h-full efm:flex-col efm:items-center efm:justify-center efm:gap-6 efm:bg-surface-sunken efm:px-6 efm:text-center efm:select-none',
        className,
      )}
    >
      {icon !== undefined && (
        <div aria-hidden='true' className='efm:text-[64px] efm:leading-none efm:text-border'>
          {icon}
        </div>
      )}
      <p className='efm:text-[15px] efm:text-fg-muted'>{title}</p>
      <div className='efm:flex efm:w-[340px] efm:max-w-full efm:flex-col efm:gap-3 efm:text-left efm:text-fg-muted'>
        {rows.map((entry, index) =>
          entry.onClick ? (
            <button
              key={index}
              type='button'
              className={cn(row, 'efm:cursor-pointer efm:hover:text-fg')}
              onClick={entry.onClick}
            >
              <span>{entry.label}</span>
              {entry.hint !== undefined && <span className='efm:text-[12px]'>{entry.hint}</span>}
            </button>
          ) : (
            <div key={index} className={row}>
              <span>{entry.label}</span>
              {entry.hint !== undefined && <span className='efm:text-[12px]'>{entry.hint}</span>}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export { EmptyState, RecentList, WelcomeAction, WelcomeLayout, WelcomeSection };
export type { EmptyStateRow, RecentEntry };
