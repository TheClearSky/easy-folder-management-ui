import { useCallback, useEffect, useId, useRef, useState } from 'react';

type UnsavedChoice = 'save' | 'discard' | 'cancel';
type Request = { names: readonly string[]; resolve(choice: UnsavedChoice): void };

type UnsavedChangesStrings = {
  titleOne(name: string): string;
  titleMany(count: number): string;
  body: string;
  save: string;
  discard: string;
  cancel: string;
};

const DEFAULT_STRINGS: UnsavedChangesStrings = {
  titleOne: (name) => `Save changes to “${name}”?`,
  titleMany: (count) => `Save changes to ${count} files?`,
  body: 'Your changes will be lost if you don’t save them.',
  save: 'Save',
  discard: 'Don’t save',
  cancel: 'Cancel',
};

/**
 * "Save changes before closing?" — Save / Don't save / Cancel, like every
 * editor. A native `<dialog>` opened with `showModal()`: the browser traps
 * focus, makes the rest of the page inert and maps Escape to Cancel.
 *
 * Returns the async `ask(names)` (hand it to the workspace as its
 * `confirmUnsaved`) and the element to render.
 */
function useUnsavedChangesDialog(strings?: Partial<UnsavedChangesStrings>) {
  const [request, setRequest] = useState<Request | null>(null);
  const ask = useCallback(
    (names: readonly string[]) => new Promise<UnsavedChoice>((resolve) => setRequest({ names, resolve })),
    [],
  );
  const element = request ? (
    <UnsavedChangesDialog
      names={request.names}
      strings={{ ...DEFAULT_STRINGS, ...strings }}
      onChoose={(choice) => {
        request.resolve(choice);
        setRequest(null);
      }}
    />
  ) : null;
  return { ask, element };
}

const BUTTON = 'efm:cursor-pointer efm:rounded efm:px-3 efm:py-1.5 efm:text-[13px] efm:hover:bg-hover';

function UnsavedChangesDialog({
  names,
  strings,
  onChoose,
}: {
  names: readonly string[];
  strings: UnsavedChangesStrings;
  onChoose(choice: UnsavedChoice): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Unique per instance: a fixed id collided when two apps (or two dialogs)
  // shared a page.
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const single = names.length === 1;
  return (
    <dialog
      ref={ref}
      data-efm='unsaved-dialog'
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onChoose('cancel');
      }}
      className='efm:m-auto efm:w-[420px] efm:max-w-[calc(100vw-32px)] efm:rounded-lg efm:border efm:border-border efm:bg-surface-raised efm:p-5 efm:text-fg efm:backdrop:bg-black/60'
    >
      <h2 id={titleId} className='efm:mb-2 efm:text-[15px] efm:font-semibold'>
        {single ? strings.titleOne(names[0]) : strings.titleMany(names.length)}
      </h2>
      {!single && (
        <ul className='efm:mb-2 efm:max-h-40 efm:list-disc efm:overflow-auto efm:pl-5 efm:text-[13px] efm:text-fg-muted'>
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      <p className='efm:mb-4 efm:text-[13px] efm:text-fg-muted'>{strings.body}</p>
      <div className='efm:flex efm:justify-end efm:gap-2'>
        <button type='button' className={BUTTON} onClick={() => onChoose('discard')}>
          {strings.discard}
        </button>
        <button type='button' className={BUTTON} onClick={() => onChoose('cancel')}>
          {strings.cancel}
        </button>
        <button
          type='button'
          autoFocus
          className='efm:cursor-pointer efm:rounded efm:bg-accent efm:px-3 efm:py-1.5 efm:text-[13px] efm:font-semibold efm:text-white efm:hover:brightness-110'
          onClick={() => onChoose('save')}
        >
          {strings.save}
        </button>
      </div>
    </dialog>
  );
}

export { useUnsavedChangesDialog };
export type { UnsavedChangesStrings, UnsavedChoice };
