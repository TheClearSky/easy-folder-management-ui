/**
 * File and folder NAME rules for the library.
 *
 * One rule set for every mode and every OS. A library made in memory can be
 * linked to a folder later, and a folder can be moved between machines, so a
 * name that only one filesystem accepts is a name that breaks somewhere else.
 * The rules are therefore the union of the strictest ones:
 *
 *  - Windows' forbidden characters and reserved device names apply everywhere
 *    (`CON.json` is legal on macOS and unopenable on Windows);
 *  - names COLLIDE case-insensitively everywhere (Windows and default macOS
 *    volumes are case-insensitive; a Linux folder with `Kick.json` and
 *    `kick.json` side by side cannot be copied to either);
 *  - a trailing dot or space is rejected (Windows silently strips it, so the
 *    file on disk would not have the name the tree shows).
 */

const FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;
/** The same class, global, for replacing every occurrence. */
const FORBIDDEN_CHARACTERS_GLOBAL = new RegExp(FORBIDDEN_CHARACTERS.source, 'g');

/** Unicode format characters (soft hyphen, zero-width space/joiners,
 *  directional marks, BOM, word joiners) — invisible, and refused by Chrome. */
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

/** Extensions Chrome will not let a website read or write (shortcuts). */
const BLOCKED_EXTENSIONS = /\.(lnk|url|scf|local)$/i;

/** Windows device names — reserved with ANY extension (`nul.json` too). */
const RESERVED_STEMS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** Most filesystems cap a single name at 255 bytes; UTF-16 units is a safe
 *  proxy that errs on the short side for non-ASCII names. */
const MAX_NAME_LENGTH = 255;

/** Why `name` cannot be used, or `null` when it can. */
function validateName(name: string): string | null {
  if (name.trim().length === 0) return 'A name cannot be empty.';
  if (name === '.' || name === '..') return `"${name}" is not a valid name.`;
  if (FORBIDDEN_CHARACTERS.test(name)) {
    return 'Names cannot contain < > : " / \\ | ? * or control characters.';
  }
  if (/[. ]$/.test(name)) {
    return 'Names cannot end with a dot or a space.';
  }
  if (name !== name.trimStart()) return 'Names cannot start with a space.';
  // A leading dot HIDES the item: a linked folder's scan skips dot-entries,
  // so a file renamed ".kick.json" would vanish from the tree on the next
  // re-scan while still sitting on disk.
  if (name.startsWith('.')) {
    return 'Names cannot start with a dot — the item would be hidden.';
  }
  // Chrome refuses these for real folders (IsFilenameLegal): a leading or
  // trailing "~", and invisible format characters. Accepting them here would
  // make the item uncreatable, or unlistable, the moment a folder is linked.
  if (name.startsWith('~') || name.endsWith('~')) {
    return 'Names cannot start or end with "~".';
  }
  if (INVISIBLE_CHARACTERS.test(name)) {
    return 'Names cannot contain invisible formatting characters.';
  }
  if (BLOCKED_EXTENSIONS.test(name)) {
    return 'Browsers do not allow websites to create files with that extension.';
  }
  const stem = name.split('.')[0].toLowerCase();
  if (RESERVED_STEMS.has(stem)) {
    return `"${name}" is a reserved name on Windows.`;
  }
  if (name.length > MAX_NAME_LENGTH) return 'That name is too long.';
  return null;
}

/** Folded form for comparisons: case-insensitive and Unicode-normalised, so
 *  "Café" typed two different ways is still one name. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/**
 * Entries a linked folder scan skips entirely: dot-folders and dot-files
 * (`.git`, `.DS_Store`), `node_modules`, and Chrome's `*.crswap` swap files
 * — the latter are the browser's own half-written temporaries and appear in
 * a folder listing for the duration of every write.
 */
function isHiddenEntry(name: string): boolean {
  return (
    name.startsWith('.') ||
    name === 'node_modules' ||
    nameKey(name).endsWith('.crswap')
  );
}

/** `"kick.json"` → `{ stem: "kick", extension: ".json" }`. A leading-dot
 *  name has no extension; neither does a name without a dot. */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * `desired` if no sibling has it, else the first free `"stem N.ext"` from 2
 * up — VS Code's and Finder's convention ("Untitled 2.json").
 */
function uniqueName(desired: string, siblingNames: Iterable<string>): string {
  const taken = new Set<string>();
  for (const sibling of siblingNames) taken.add(nameKey(sibling));
  if (!taken.has(nameKey(desired))) return desired;
  const { stem, extension } = splitExtension(desired);
  // Continue an existing counter rather than stacking one ("Kick 2 2").
  const counted = /^(.*) (\d+)$/.exec(stem);
  const base = counted ? counted[1] : stem;
  let counter = counted ? Number(counted[2]) + 1 : 2;
  for (;;) {
    const candidate = `${base} ${counter}${extension}`;
    if (!taken.has(nameKey(candidate))) return candidate;
    counter += 1;
  }
}

/**
 * A file name for a title that may contain anything (a demo's menu label, an
 * imported file's name): forbidden characters become spaces, runs of
 * whitespace collapse, and `extension` (e.g. `".json"`) is appended when
 * missing.
 */
function toFileName(title: string, extension?: string): string {
  const cleaned = title
    .replace(FORBIDDEN_CHARACTERS_GLOBAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const base = cleaned.length > 0 ? cleaned : 'Untitled';
  const named =
    extension === undefined || nameKey(base).endsWith(nameKey(extension))
      ? base
      : `${base}${extension}`;
  const stem = splitExtension(named).stem.split('.')[0].toLowerCase();
  return RESERVED_STEMS.has(stem) ? `_${named}` : named;
}

export {
  isHiddenEntry,
  nameKey,
  sameName,
  splitExtension,
  toFileName,
  uniqueName,
  validateName,
};
