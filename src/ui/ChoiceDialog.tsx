import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { cn } from './cn';
import { useFolderTheme } from './theme/FolderThemeContext';

type ChoiceTone = 'primary' | 'danger' | 'neutral';

type Choice<Id extends string = string> = {
  id: Id;
  label: string;
  /** `'primary'` gets the accent and the initial focus; `'danger'` is red.
   *  Default `'neutral'`. */
  tone?: ChoiceTone;
  /** A line under the label (choices then stack vertically). */
  description?: string;
  disabled?: boolean;
};

type ChoiceRequest<Id extends string = string> = {
  title: string;
  body?: ReactNode;
  choices: readonly Choice<Id>[];
  /** The Cancel button's label (Escape cancels too). */
  cancelLabel?: string;
};

/** A progress view in the same modal: a bar, a line of text, and Cancel. */
type ChoiceProgress = {
  title: string;
  body?: ReactNode;
  /** 0…1, or `null` while the total is unknown. */
  value: number | null;
  /** Under the bar, e.g. `1.2 GB of 3.4 GB`. */
  text?: string;
  /** Shows a Cancel button; Escape calls it too. Without it the view cannot
   *  be dismissed (it closes when the app stops showing it). */
  onCancel?(): void;
  cancelLabel?: string;
};

type ChoiceDialogStrings = {
  cancel: string;
};

const DEFAULT_STRINGS: ChoiceDialogStrings = { cancel: 'Cancel' };

type Pending = { request: ChoiceRequest; resolve(id: string): void; key: number };

/**
 * One accessible modal for every question the library's flows ask: link
 * read-only or read & write, unlink KEEP or REMOVE (with sizes and free
 * space), delete — and a progress view with Cancel for a long copy.
 *
 * A native `<dialog>` opened with `showModal()`: the browser traps focus,
 * makes the page inert and maps Escape to Cancel. Initial focus goes to the
 * `'primary'` choice, else to Cancel (a destructive choice is never the
 * default). Touch screens get larger targets.
 *
 *     const dialog = useChoiceDialog();
 *     const choice = await dialog.ask({ title, body, choices }); // id | 'cancel'
 *     dialog.showProgress({ title: 'Copying…', value: 0.4, onCancel });
 *     dialog.showProgress(null);
 *     return <>{app}{dialog.element}</>;
 *
 * A question asked while another is open replaces it (the older one
 * resolves `'cancel'`). A question shows over a progress view.
 */
function useChoiceDialog(strings?: Partial<ChoiceDialogStrings>) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [progress, setProgress] = useState<ChoiceProgress | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const counter = useRef(0);

  const ask = useCallback(
    <Id extends string>(request: ChoiceRequest<Id>) =>
      new Promise<Id | 'cancel'>((resolve) => {
        pendingRef.current?.resolve('cancel');
        counter.current += 1;
        const next: Pending = {
          request: request as ChoiceRequest,
          resolve: resolve as (id: string) => void,
          key: counter.current,
        };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const showProgress = useCallback((view: ChoiceProgress | null) => setProgress(view), []);

  // A dialog that unmounts with a question open answers it: never a promise
  // left hanging (a workspace operation awaiting it would hang forever).
  useEffect(
    () => () => {
      pendingRef.current?.resolve('cancel');
      pendingRef.current = null;
    },
    [],
  );

  const merged = { ...DEFAULT_STRINGS, ...strings };
  const choose = (target: Pending, id: string) => {
    target.resolve(id);
    if (pendingRef.current === target) {
      pendingRef.current = null;
      setPending(null);
    }
  };

  const element = pending ? (
    <ChoiceView key={pending.key} request={pending.request} strings={merged} onChoose={(id) => choose(pending, id)} />
  ) : progress ? (
    <ProgressView view={progress} strings={merged} />
  ) : null;

  return { ask, showProgress, element };
}

/** The `<dialog>` shell shared by both views. */
function Modal(props: {
  labelledBy: string;
  describedBy?: string;
  onCancel(): void;
  initialFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
  kind: string;
  /** The theme's `choiceDialog.panel` slot. */
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // React's autoFocus runs before showModal, which then moves focus
    // itself; focus explicitly once the dialog is open.
    (props.initialFocus.current ?? dialog).focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []); // opened once per mount
  return (
    <dialog
      ref={ref}
      data-efm={props.kind}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      onCancel={(event) => {
        event.preventDefault();
        onCancelRef.current();
      }}
      onClose={() => {
        // Closed by the browser itself (it may force-close a dialog whose
        // Escape is cancelled repeatedly): treat as Cancel.
        if (ref.current && !ref.current.open) onCancelRef.current();
      }}
      className={cn(
        'efm:m-auto efm:w-[460px] efm:max-w-[calc(100vw-32px)] efm:rounded-lg efm:border efm:border-border efm:bg-surface-raised efm:p-5 efm:text-fg efm:outline-none efm:backdrop:bg-overlay efm:pointer-coarse:p-6',
        props.className,
      )}
    >
      {props.children}
    </dialog>
  );
}

const BUTTON =
  'efm:cursor-pointer efm:rounded efm:px-3 efm:py-1.5 efm:text-[13px] efm:outline-none efm:focus-visible:shadow-[0_0_0_2px_var(--efm-focus,var(--efm-accent))] efm:disabled:cursor-default efm:disabled:opacity-40 efm:pointer-coarse:px-4 efm:pointer-coarse:py-3 efm:pointer-coarse:text-[15px]';
const TONE: Record<ChoiceTone, string> = {
  primary: 'efm:bg-accent efm:font-semibold efm:text-on-accent efm:enabled:hover:brightness-110',
  danger: 'efm:bg-danger efm:font-semibold efm:text-on-accent efm:enabled:hover:brightness-110',
  neutral: 'efm:border efm:border-border efm:enabled:hover:bg-hover',
};
const STACKED_TONE: Record<ChoiceTone, string> = {
  primary: 'efm:border-accent efm:bg-accent/15',
  // The label is red; the description keeps its own muted colour.
  danger: 'efm:border-danger/70 efm:text-danger',
  neutral: 'efm:border-border',
};
const TONE_SLOT = {
  choice: { primary: 'choicePrimary', danger: 'choiceDanger', neutral: 'choiceNeutral' },
  card: { primary: 'cardPrimary', danger: 'cardDanger', neutral: 'cardNeutral' },
} as const;

function ChoiceView({
  request,
  strings,
  onChoose,
}: {
  request: ChoiceRequest;
  strings: ChoiceDialogStrings;
  onChoose(id: string): void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const slots = useFolderTheme()?.choiceDialog;
  const primary = request.choices.find((choice) => choice.tone === 'primary' && !choice.disabled);
  const stacked = request.choices.some((choice) => choice.description);
  const cancel = (
    <button
      ref={cancelRef}
      type='button'
      className={cn(BUTTON, 'efm:hover:bg-hover', slots?.button, slots?.cancel)}
      onClick={() => onChoose('cancel')}
    >
      {request.cancelLabel ?? strings.cancel}
    </button>
  );
  return (
    <Modal
      kind='choice-dialog'
      labelledBy={titleId}
      describedBy={request.body ? bodyId : undefined}
      onCancel={() => onChoose('cancel')}
      initialFocus={primary ? primaryRef : cancelRef}
      className={slots?.panel}
    >
      <h2 id={titleId} className={cn('efm:mb-2 efm:text-[15px] efm:font-semibold efm:pointer-coarse:text-[17px]', slots?.title)}>
        {request.title}
      </h2>
      {request.body && (
        <div
          id={bodyId}
          className={cn('efm:mb-4 efm:text-[13px] efm:leading-relaxed efm:text-fg-muted efm:pointer-coarse:text-[15px]', slots?.body)}
        >
          {request.body}
        </div>
      )}
      {stacked ? (
        <>
          <div className={cn('efm:mb-4 efm:flex efm:flex-col efm:gap-2', slots?.cards)}>
            {request.choices.map((choice) => (
              <button
                key={choice.id}
                ref={choice === primary ? primaryRef : undefined}
                type='button'
                disabled={choice.disabled}
                data-choice={choice.id}
                onClick={() => onChoose(choice.id)}
                className={cn(
                  BUTTON,
                  'efm:flex efm:flex-col efm:items-start efm:gap-0.5 efm:border efm:px-3 efm:py-2 efm:text-left efm:enabled:hover:bg-hover',
                  STACKED_TONE[choice.tone ?? 'neutral'],
                  slots?.button,
                  slots?.card,
                  slots?.[TONE_SLOT.card[choice.tone ?? 'neutral']],
                )}
              >
                <span className={cn('efm:font-semibold', slots?.cardLabel)}>{choice.label}</span>
                {choice.description && (
                  <span className={cn('efm:text-[12px] efm:text-fg-muted efm:pointer-coarse:text-[14px]', slots?.cardDescription)}>
                    {choice.description}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className={cn('efm:flex efm:justify-end', slots?.actions)}>{cancel}</div>
        </>
      ) : (
        <div className={cn('efm:flex efm:flex-wrap efm:justify-end efm:gap-2', slots?.actions)}>
          {cancel}
          {request.choices.map((choice) => (
            <button
              key={choice.id}
              ref={choice === primary ? primaryRef : undefined}
              type='button'
              disabled={choice.disabled}
              data-choice={choice.id}
              onClick={() => onChoose(choice.id)}
              className={cn(
                BUTTON,
                TONE[choice.tone ?? 'neutral'],
                slots?.button,
                slots?.choice,
                slots?.[TONE_SLOT.choice[choice.tone ?? 'neutral']],
              )}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function ProgressView({ view, strings }: { view: ChoiceProgress; strings: ChoiceDialogStrings }) {
  const titleId = useId();
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const slots = useFolderTheme()?.choiceDialog;
  const percent = view.value === null ? null : Math.max(0, Math.min(100, view.value * 100));
  return (
    <Modal
      kind='progress-dialog'
      labelledBy={titleId}
      describedBy={view.text ? textId : undefined}
      onCancel={() => view.onCancel?.()}
      initialFocus={cancelRef}
      className={slots?.panel}
    >
      <h2 id={titleId} className={cn('efm:mb-2 efm:text-[15px] efm:font-semibold efm:pointer-coarse:text-[17px]', slots?.title)}>
        {view.title}
      </h2>
      {view.body && (
        <div className={cn('efm:mb-3 efm:text-[13px] efm:leading-relaxed efm:text-fg-muted efm:pointer-coarse:text-[15px]', slots?.body)}>
          {view.body}
        </div>
      )}
      <div
        role='progressbar'
        aria-labelledby={titleId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        className={cn('efm:h-2 efm:w-full efm:overflow-hidden efm:rounded-full efm:bg-surface-sunken efm:pointer-coarse:h-3', slots?.progressTrack)}
      >
        <div
          className={cn('efm:h-full efm:rounded-full efm:bg-accent', percent === null && 'efm:animate-pulse', slots?.progressBar)}
          style={{ width: `${percent ?? 35}%` }}
        />
      </div>
      {view.text && (
        <p
          id={textId}
          aria-live='polite'
          className={cn('efm:mt-2 efm:text-[12px] efm:text-fg-muted efm:tabular-nums efm:pointer-coarse:text-[14px]', slots?.progressText)}
        >
          {view.text}
        </p>
      )}
      {view.onCancel && (
        <div className={cn('efm:mt-4 efm:flex efm:justify-end', slots?.actions)}>
          <button
            ref={cancelRef}
            type='button'
            className={cn(BUTTON, TONE.neutral, slots?.button, slots?.cancel)}
            onClick={() => view.onCancel?.()}
          >
            {view.cancelLabel ?? strings.cancel}
          </button>
        </div>
      )}
    </Modal>
  );
}

export { useChoiceDialog };
export type { Choice, ChoiceDialogStrings, ChoiceProgress, ChoiceRequest, ChoiceTone };
