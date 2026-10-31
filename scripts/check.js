#!/usr/bin/env node
/**
 * Checks to run before pushing. They cover what this branch changes since it
 * left `origin/main` (commits, staged and unstaged edits, untracked files) and
 * take seconds, so the pre-push hook in `scripts/git-hooks/` runs them on
 * every push:
 *
 * - prettier, on the changed files CI's Format job checks;
 * - `zena lint`, on the changed lines of changed `.zena` files under
 *   `packages/` (skipped with a note when `zena-cli` is not built);
 * - commit subjects, which start with package tags: `[stdlib] Add ...`;
 * - words listed in `<git common dir>/info/private-words`, one per line, in
 *   the added lines and the commit messages. The list lives outside the
 *   repository because the words are the thing to keep out of it.
 *
 * Phrases that docs/writing-style.md asks prose to avoid are reported as
 * warnings, on the added lines of Markdown files and in commit messages.
 * They never fail the check, since each has legitimate uses.
 *
 * Options:
 *   --fix          run prettier --write instead of --check
 *   --base <ref>   compare against <ref> instead of origin/main
 *   --text <file>  also check a PR title and description saved in <file>,
 *                  for private words and phrases
 *
 * Run from the repository root:  npm run check [-- --fix]
 */

import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const PRETTIER_EXTENSIONS = /\.(cjs|html|js|json|md|ts)$/;
const LINTED = /^packages\/.*\.zena$/;
const NOT_LINTED = [
  // Inputs the compiler's own tests compile, many deliberately unidiomatic.
  /^packages\/zena-compiler\/test-files\//,
];
const SUBJECT = /^(\[[a-z0-9][a-z0-9.-]*\])+ \S/;

/** From docs/writing-style.md, "Voice". */
const PHRASES = [
  'load-bearing',
  'the key insight',
  'critically,',
  'importantly,',
  'seamless',
  'blazing',
  'not merely',
  'more than just',
  'it is worth noting',
  "it's worth noting",
  'as discussed',
  'per the plan',
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const git = (...argv) =>
  execFileSync('git', argv, {encoding: 'utf8', maxBuffer: 1 << 28});
const lines = (text) => text.split('\n').filter((line) => line !== '');

const errors = [];
const warnings = [];
const notes = [];

const base = git(
  'merge-base',
  'HEAD',
  option('--base') ?? 'origin/main',
).trim();

const changed = [
  ...new Set([
    ...lines(git('diff', '--name-only', '--diff-filter=ACMR', base)),
    ...lines(git('ls-files', '--others', '--exclude-standard')),
  ]),
].filter((file) => existsSync(file));
const untracked = new Set(
  lines(git('ls-files', '--others', '--exclude-standard')),
);

/** Added lines per file, as a map from file to [line number, text] pairs. */
const addedLines = (file) => {
  if (untracked.has(file)) {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((text, i) => [i + 1, text]);
  }
  const added = [];
  let next = 0;
  for (const line of git('diff', '-U0', base, '--', file).split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push([next, line.slice(1)]);
      next += 1;
    }
  }
  return added;
};

const messages = git('log', '--format=%H%x00%s%x00%B%x00', `${base}..HEAD`)
  .split('\0\n')
  .filter((entry) => entry.trim() !== '')
  .map((entry) => {
    const [sha, subject, body] = entry.replace(/^\n/, '').split('\0');
    return {sha: sha.slice(0, 10), subject, body};
  });

// prettier
const formatted = changed.filter((file) => PRETTIER_EXTENSIONS.test(file));
if (formatted.length > 0) {
  const prettier = 'node_modules/.bin/prettier';
  if (!existsSync(prettier)) {
    errors.push('prettier: node_modules is missing; run `npm ci`');
  } else {
    const result = spawnSync(
      prettier,
      [flag('--fix') ? '--write' : '--list-different', ...formatted],
      {encoding: 'utf8'},
    );
    if (!flag('--fix') && result.status !== 0) {
      for (const file of lines(result.stdout)) {
        errors.push(`${file}: not formatted (npm run check -- --fix)`);
      }
      if (result.stderr.trim() !== '') errors.push(result.stderr.trim());
    }
  }
}

// zena lint
const linted = changed.filter(
  (file) => LINTED.test(file) && !NOT_LINTED.some((re) => re.test(file)),
);
if (linted.length > 0) {
  const zena = './target/release/zena-cli';
  if (!existsSync(zena)) {
    notes.push(
      'zena lint: skipped, zena-cli is not built (npm run build -w @zena-lang/zena-cli)',
    );
  } else {
    const result = spawnSync(zena, ['lint', ...linted], {encoding: 'utf8'});
    const touched = new Map(
      linted.map((file) => [file, new Set(addedLines(file).map(([n]) => n))]),
    );
    for (const finding of lines(result.stdout)) {
      const match = /^(.+?):(\d+):\d+: /.exec(finding);
      if (match && touched.get(match[1])?.has(Number(match[2]))) {
        errors.push(`${finding} (zena lint --fix ${match[1]})`);
      }
    }
  }
}

// commit subjects
for (const {sha, subject} of messages) {
  if (!SUBJECT.test(subject)) {
    errors.push(
      `${sha}: subject needs package tags, like "[stdlib] Add ..." or "[pds][zena-cli] Fix ...": ${subject}`,
    );
  }
}

// private words and phrases
const privateWordsFile = join(
  git('rev-parse', '--git-common-dir').trim(),
  'info',
  'private-words',
);
const privateWords = existsSync(privateWordsFile)
  ? lines(readFileSync(privateWordsFile, 'utf8'))
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word !== '' && !word.startsWith('#'))
  : [];

const texts = [
  ...changed.flatMap((file) =>
    addedLines(file).map(([n, text]) => ({where: `${file}:${n}`, text, file})),
  ),
  ...messages.map(({sha, body}) => ({where: `commit ${sha}`, text: body})),
];
const textFile = option('--text');
if (textFile !== undefined) {
  texts.push({where: textFile, text: readFileSync(textFile, 'utf8')});
}

for (const {where, text, file} of texts) {
  const lower = text.toLowerCase();
  for (const word of privateWords) {
    if (lower.includes(word)) {
      errors.push(`${where}: contains a word from ${privateWordsFile}`);
    }
  }
  if (file === undefined || file.endsWith('.md')) {
    for (const phrase of PHRASES) {
      if (lower.includes(phrase)) {
        warnings.push(
          `${where}: "${phrase}" (see docs/writing-style.md, "Voice")`,
        );
      }
    }
  }
}

for (const note of notes) console.log(`note: ${note}`);
for (const warning of warnings) console.log(`warning: ${warning}`);
for (const error of errors) console.log(`error: ${error}`);
console.log(
  `check: ${changed.length} changed files, ${messages.length} commits since ${base.slice(0, 10)}: ` +
    `${errors.length} errors, ${warnings.length} warnings`,
);
process.exit(errors.length > 0 ? 1 : 0);
