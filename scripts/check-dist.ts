/**
 * Build gate: every file the package manifest points at exists, and every
 * ESM entry evaluates in plain Node (no DOM) — a module that touched
 * `window`/`document` at import time would crash here, and server-rendered
 * apps with it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string | Record<string, string>>;
};

let failed = false;
const fail = (message: string) => {
  failed = true;
  console.error(`[check-dist] FAIL ${message}`);
};

for (const [subpath, target] of Object.entries(manifest.exports)) {
  const targets = typeof target === 'string' ? { file: target } : target;
  for (const [condition, file] of Object.entries(targets)) {
    if (!existsSync(path.join(root, file))) fail(`${subpath} → ${condition}: ${file} is missing`);
  }
  if (typeof target !== 'string' && target.import) {
    try {
      const module = (await import(pathToFileURL(path.join(root, target.import)).href)) as Record<string, unknown>;
      const names = Object.keys(module);
      if (names.length === 0) fail(`${subpath}: no exports`);
      else console.log(`[check-dist] PASS ${subpath} loads (${names.length} exports)`);
    } catch (error) {
      fail(`${subpath}: import failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failed) process.exit(1);
console.log('[check-dist] OK');
