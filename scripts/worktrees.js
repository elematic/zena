#!/usr/bin/env node
/**
 * Lists this repository's worktrees by whether removing one could lose
 * work, and with `--remove` removes the ones that cannot:
 *
 * - **unmerged work**: uncommitted or untracked files, an open PR, commits
 *   no remote branch has, or commits in no merged PR. Never removed.
 * - **merged, recent**: clean, and everything it has is in a merged PR or
 *   on `main`, but it was used in the last `--idle-hours` (default 48) or
 *   a process is running in it, so a session may still be working there.
 * - **merged, idle**: the same, older and with no process in it. `--remove`
 *   removes these.
 *
 * Removing a worktree deletes its directory: the checkout, its build
 * output and caches. Branches are left alone, since they are shared by
 * every worktree, so a session that comes back to a removed worktree can
 * recreate it with `git worktree add <path> <branch>`.
 *
 * Run from any checkout of the repository; it uses `gh` for PR states.
 *
 *   npm run worktrees [-- --remove] [--idle-hours <n>]
 */

import {execFileSync} from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import {join, resolve} from 'node:path';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const idleIndex = args.indexOf('--idle-hours');
const idleHours = idleIndex >= 0 ? Number(args[idleIndex + 1]) : 48;

const run = (command, argv, options = {}) =>
  execFileSync(command, argv, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
const git = (cwd, ...argv) => run('git', ['-C', cwd, ...argv]).trim();
const succeeds = (cwd, ...argv) => {
  try {
    run('git', ['-C', cwd, ...argv]);
    return true;
  } catch {
    return false;
  }
};

const here = git('.', 'rev-parse', '--show-toplevel');
run('git', ['-C', here, 'fetch', '--quiet', 'origin', 'main']);

const worktrees = [];
for (const block of git(here, 'worktree', 'list', '--porcelain').split(
  '\n\n',
)) {
  const fields = Object.fromEntries(
    block.split('\n').map((line) => {
      const space = line.indexOf(' ');
      return space < 0
        ? [line, true]
        : [line.slice(0, space), line.slice(space + 1)];
    }),
  );
  if (fields.worktree) worktrees.push(fields);
}

const prs = JSON.parse(
  run('gh', [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    '2000',
    '--json',
    'number,state,headRefName,headRefOid',
  ]),
);
const prByHead = new Map(prs.map((pr) => [pr.headRefOid, pr]));
const mergedByBranch = new Map();
for (const pr of prs.filter((pr) => pr.state === 'MERGED')) {
  mergedByBranch.set(pr.headRefName, [
    ...(mergedByBranch.get(pr.headRefName) ?? []),
    pr,
  ]);
}
const openByBranch = new Map(
  prs.filter((pr) => pr.state === 'OPEN').map((pr) => [pr.headRefName, pr]),
);

/** Worktree paths that a running process has as its working directory. */
const busy = new Set();
for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
  try {
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    for (const {worktree} of worktrees) {
      if (cwd === worktree || cwd.startsWith(`${worktree}/`))
        busy.add(worktree);
    }
  } catch {
    // The process exited, or belongs to another user.
  }
}

/** When HEAD last moved, or its commit was made, whichever is later. */
const lastUsed = (path) => {
  let latest = Number(git(path, 'log', '-1', '--format=%ct')) * 1000;
  const gitDir = resolve(path, git(path, 'rev-parse', '--git-dir'));
  const log = join(gitDir, 'logs', 'HEAD');
  if (existsSync(log)) latest = Math.max(latest, statSync(log).mtimeMs);
  return latest;
};

const rows = [];
// The first entry is the main checkout, which git does not remove.
for (const entry of worktrees.slice(1)) {
  const path = entry.worktree;
  const branch = entry.branch?.replace('refs/heads/', '') ?? '(detached)';
  if (!existsSync(path)) {
    rows.push({
      path,
      branch,
      kind: 'missing',
      reasons: ['directory is gone; git worktree prune'],
    });
    continue;
  }
  const reasons = [];
  // Not trimmed: each line starts with a two-column status code.
  const status = run('git', ['-C', path, 'status', '--porcelain'])
    .split('\n')
    .filter(Boolean);
  if (status.length > 0) {
    const paths = status.slice(0, 3).map((line) => line.slice(3));
    reasons.push(
      `${status.length} uncommitted or untracked: ${paths.join(', ')}` +
        (status.length > 3 ? ', ...' : ''),
    );
  }
  const head = entry.HEAD;
  // The PR whose head this is, or a merged PR of this branch that contains
  // it (the worktree stopped at an earlier commit of the branch).
  const pr =
    prByHead.get(head) ??
    (mergedByBranch.get(branch) ?? []).find((merged) =>
      succeeds(path, 'merge-base', '--is-ancestor', head, merged.headRefOid),
    );
  const open = openByBranch.get(branch);
  const onMain = succeeds(
    path,
    'merge-base',
    '--is-ancestor',
    head,
    'origin/main',
  );
  if (open) reasons.push(`open PR #${open.number}`);
  if (!onMain && pr?.state !== 'MERGED') {
    const unpushed = Number(
      git(path, 'rev-list', '--count', 'HEAD', '--not', '--remotes'),
    );
    if (unpushed > 0) reasons.push(`${unpushed} commits on no remote branch`);
    if (pr?.state === 'CLOSED')
      reasons.push(`PR #${pr.number} closed without merging`);
    else if (!open && unpushed === 0) reasons.push('commits in no merged PR');
  }
  const idle = Date.now() - lastUsed(path) > idleHours * 3_600_000;
  const kind =
    reasons.length > 0
      ? 'unmerged work'
      : idle && !busy.has(path)
        ? 'merged, idle'
        : 'merged, recent';
  const where =
    pr?.state === 'MERGED'
      ? `merged as #${pr.number}`
      : onMain
        ? 'on main'
        : '';
  rows.push({path, branch, kind, reasons, where, busy: busy.has(path)});
}

const order = ['unmerged work', 'missing', 'merged, recent', 'merged, idle'];
rows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
for (const kind of order) {
  const group = rows.filter((row) => row.kind === kind);
  if (group.length === 0) continue;
  console.log(`\n${kind} (${group.length})`);
  for (const row of group) {
    const notes = [
      row.where,
      row.busy && 'a process is running in it',
      ...row.reasons,
    ].filter(Boolean);
    console.log(`  ${row.path}  [${row.branch}]  ${notes.join('; ')}`);
  }
}

if (remove) {
  for (const row of rows.filter((r) => r.kind === 'merged, idle')) {
    try {
      // Without --force, git refuses a worktree that gained changes since
      // it was listed. Ignored files (build output) do not count.
      git(here, 'worktree', 'remove', row.path);
      console.log(`removed ${row.path}`);
    } catch (error) {
      console.log(`could not remove ${row.path}: ${error.stderr ?? error}`);
    }
  }
  git(here, 'worktree', 'prune');
}
