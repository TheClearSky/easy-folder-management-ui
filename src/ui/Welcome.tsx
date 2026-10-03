import type { ReactNode } from 'react';
import { cn } from './cn';
import { useFolderTheme } from './theme/FolderThemeContext';

/**
 * Building blocks for a Welcome page and a "nothing is open" view — layout
 * only; the app supplies the content (Nodestra: demos, tutorials, a piano;
 * watch-together: rooms). From Nodestra's WelcomePage/EmptyEditor, which were
 * ~20% generic: these are that 20%.
 */

function WelcomeLayout({ title, children, className }: { title: ReactNode; children: ReactNode; className?: string }) {
  const slots = useFolderTheme()?.welcome;
  return (
    <div
      data-efm='welcome'
      className={cn(
        'efm:h-full efm:overflow-auto efm:bg-surface-sunken efm:px-4 efm:py-6 efm:text-fg efm:sm:px-10 efm:sm:py-8',
        slots?.layout,
        className,
      )}
    >
      <div className={cn('efm:mx-auto efm:flex efm:max-w-[920px] efm:flex-col efm:gap-8', slots?.content)}>
        <h1 className={cn('efm:flex efm:items-center efm:gap-3 efm:text-[26px] efm:font-light', slots?.title)}>{title}</h1>
        <div className={cn('efm:grid efm:grid-cols-1 efm:gap-8 efm:md:grid-cols-2', slots?.grid)}>{children}</div>
      </div>
    </div>
  );
}

function WelcomeSection({
  title,
  children,
  wide,
  className,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const slots = useFolderTheme()?.welcome;
  return (
    <section className={cn('efm:flex efm:flex-col efm:gap-1.5', wide && 'efm:md:col-span-2', slots?.section, className)}>
      <h2
        className={cn(
          'efm:mb-1 efm:text-[11px] efm:font-semibold efm:tracking-[0.12em] efm:text-fg-muted efm:uppercase',
          slots?.sectionTitle,
        )}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const ACTION =
  'efm:flex efm:w-full efm:cursor-pointer efm:items-center efm:gap-2 efm:rounded efm:px-2 efm:py-1 efm:text-left efm:text-[13px] efm:text-accent efm:hover:bg-surface-raised efm:disabled:cursor-default efm:disabled:opacity-40 efm:disabled:hover:bg-transparent efm:pointer-coarse:py-3 efm:pointer-coarse:text-[15px]';

function WelcomeAction({
  children,
  hint,
  disabled,
  onClick,
  className,
}: {
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  onClick(): void;
  className?: string;
}) {
  const slots = useFolderTheme()?.welcome;
  return (
    <button type='button' className={cn(ACTION, slots?.action, className)} disabled={disabled} onClick={onClick}>
      <span className={cn('efm:min-w-0 efm:flex-1 efm:truncate', slots?.actionLabel)}>{children}</span>
      {hint !== undefined && <span className={cn('efm:flex-none efm:text-[12px] efm:text-fg-muted', slots?.actionHint)}>{hint}</span>}
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
  const slots = useFolderTheme()?.welcome;
  if (entries.length === 0) return <p className={cn('efm:px-2 efm:text-[12px] efm:text-fg-muted', slots?.recentEmpty)}>{empty}</p>;
  return (
    <>
      {entries.map((entry) => (
        <WelcomeAction key={entry.id} hint={entry.detail} onClick={() => onOpen(entry.id)} className={slots?.recentItem}>
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
  const slots = useFolderTheme()?.emptyState;
  const row = cn('efm:flex efm:w-full efm:items-center efm:justify-between efm:gap-8 efm:text-[13px]', slots?.row);
  const hint = cn('efm:text-[12px]', slots?.hint);
  return (
    <div
      data-efm='empty-state'
      className={cn(
        'efm:flex efm:h-full efm:flex-col efm:items-center efm:justify-center efm:gap-6 efm:bg-surface-sunken efm:px-6 efm:text-center efm:select-none',
        slots?.root,
        className,
      )}
    >
      {icon !== undefined && (
        <div aria-hidden='true' className={cn('efm:text-[64px] efm:leading-none efm:text-border', slots?.icon)}>
          {icon}
        </div>
      )}
      <p className={cn('efm:text-[15px] efm:text-fg-muted', slots?.title)}>{title}</p>
      <div
        className={cn(
          'efm:flex efm:w-[340px] efm:max-w-full efm:flex-col efm:gap-3 efm:text-left efm:text-fg-muted',
          slots?.rows,
        )}
      >
        {rows.map((entry, index) =>
          entry.onClick ? (
            <button
              key={index}
              type='button'
              className={cn(row, 'efm:cursor-pointer efm:hover:text-fg', slots?.rowButton)}
              onClick={entry.onClick}
            >
              <span>{entry.label}</span>
              {entry.hint !== undefined && <span className={hint}>{entry.hint}</span>}
            </button>
          ) : (
            <div key={index} className={row}>
              <span>{entry.label}</span>
              {entry.hint !== undefined && <span className={hint}>{entry.hint}</span>}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export { EmptyState, RecentList, WelcomeAction, WelcomeLayout, WelcomeSection };
export type { EmptyStateRow, RecentEntry };
