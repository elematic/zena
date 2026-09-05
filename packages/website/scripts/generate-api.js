#!/usr/bin/env node
/**
 * Extracts the standard library's API into `_generated/stdlib-api.json`,
 * which `src/_data/api.js` reads and the reference pages render.
 *
 * Wireit runs this before Eleventy and re-runs it when the stdlib or the
 * extractor changes, so the reference pages cannot go stale relative to
 * the source they describe.
 */

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
const outFile = join(pkgDir, '_generated', 'stdlib-api.json');

mkdirSync(dirname(outFile), {recursive: true});

// A stdlib module that does not check clean is a bug in the stdlib, not a
// reason to fail the site build: `zena doc` writes the JSON either way and
// exits non-zero, so the warnings are reported and the pages still build.
//
// That tolerance is only for a non-zero exit that still produced the file.
// Swallowing every failure let this script exit 0 having written nothing,
// which Wireit then recorded as a success — and the site built with its
// whole standard library reference missing.
rmSync(outFile, {force: true});
let reported = null;
try {
  execFileSync(
    zenaCli,
    ['doc', join(repoRoot, 'packages', 'stdlib'), '-o', outFile],
    {stdio: 'inherit', cwd: repoRoot},
  );
} catch (e) {
  reported = e;
}

if (!existsSync(outFile)) {
  console.error(
    `zena doc wrote no ${outFile}` +
      (reported ? ` (exit ${reported.status ?? '?'})` : ''),
  );
  process.exit(1);
}
if (reported) {
  console.error(
    `zena doc reported problems in the standard library (exit ${reported.status ?? '?'}); ` +
      'the JSON was still written',
  );
}

console.log(`Wrote ${outFile}`);
