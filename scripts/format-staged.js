#!/usr/bin/env node
/**
 * Formats the staged files that CI's Format job checks, and stages the
 * result, so a commit cannot fail that job. The pre-commit hook in
 * `scripts/git-hooks/` runs it, for every agent and editor that commits.
 *
 * A file that also has unstaged changes is checked instead of formatted:
 * formatting it on disk and staging it would commit those changes too.
 * Without `node_modules` (no `npm ci` yet) it does nothing.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';

const EXTENSIONS = /\.(cjs|html|js|json|md|ts)$/;
const prettier = 'node_modules/.bin/prettier';

const names = (...argv) =>
  execFileSync('git', argv, {encoding: 'utf8'})
    .split('\n')
    .filter((name) => EXTENSIONS.test(name));

if (!existsSync(prettier)) process.exit(0);

const staged = names('diff', '--cached', '--name-only', '--diff-filter=ACMR');
const unstaged = new Set(names('diff', '--name-only'));
const whole = staged.filter((file) => !unstaged.has(file));
const partial = staged.filter((file) => unstaged.has(file));

let failed = false;
if (whole.length > 0) {
  const result = spawnSync(
    prettier,
    ['--write', '--log-level=warn', ...whole],
    {
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    failed = true;
  }
  execFileSync('git', ['add', '--', ...whole]);
}
for (const file of partial) {
  const blob = execFileSync('git', ['show', `:${file}`]);
  const result = spawnSync(prettier, ['--check', '--stdin-filepath', file], {
    input: blob,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(
      `${file}: the staged version is not formatted, and it has unstaged ` +
        `changes, so it was not formatted for you; run prettier --write on ` +
        `it and stage it\n`,
    );
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
