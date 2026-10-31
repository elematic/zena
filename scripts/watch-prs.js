#!/usr/bin/env node
/**
 * Waits until something happens to the given pull requests that the agent
 * who opened them should act on, prints what happened, and exits:
 *
 * - a PR is merged or closed;
 * - a PR's checks finish (or a new push's checks finish);
 * - someone other than the agent account reviews or comments;
 * - the PR a stacked PR is based on is merged, so the stacked PR needs
 *   rebasing onto main.
 *
 * Run it as a background task after pushing, so a merge or a red check
 * reaches the session without anyone relaying it, and start it again after
 * acting on what it printed. It prints the current state first, then polls.
 *
 *   npm run watch-prs -- [--interval <seconds>] [--once] <pr>...
 *
 * `--once` prints the current state and exits. Comments by `elematic-bot`
 * and by accounts whose login ends in `[bot]` are not reported.
 */

import {execFileSync} from 'node:child_process';

const args = process.argv.slice(2);
const intervalIndex = args.indexOf('--interval');
const interval =
  intervalIndex >= 0 ? Number(args.splice(intervalIndex, 2)[1]) : 90;
const once = args.includes('--once');
const numbers = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
if (numbers.length === 0) {
  console.error('usage: npm run watch-prs -- [--interval s] [--once] <pr>...');
  process.exit(2);
}

const AGENT = 'elematic-bot';
const isPerson = (login) => login !== AGENT && !login.endsWith('[bot]');

const gh = (...argv) =>
  JSON.parse(execFileSync('gh', argv, {encoding: 'utf8', maxBuffer: 1 << 26}));

const repo = gh('repo', 'view', '--json', 'nameWithOwner').nameWithOwner;

/** The fields of a PR this script compares between polls. */
const snapshot = (number) => {
  const pr = gh(
    'pr',
    'view',
    String(number),
    '--json',
    'number,title,state,baseRefName,headRefOid,statusCheckRollup,reviews,comments',
  );
  const inline = gh(
    'api',
    `repos/${repo}/pulls/${number}/comments`,
    '--paginate',
  );
  const checks = pr.statusCheckRollup.map((check) => ({
    name: check.name ?? check.context,
    done: (check.status ?? 'COMPLETED') === 'COMPLETED',
    result: check.conclusion ?? check.state,
  }));
  return {
    number,
    title: pr.title,
    state: pr.state,
    base: pr.baseRefName,
    head: pr.headRefOid,
    checks,
    checksDone: checks.length > 0 && checks.every((check) => check.done),
    feedback:
      pr.reviews.filter((r) => isPerson(r.author.login)).length +
      pr.comments.filter((c) => isPerson(c.author.login)).length +
      inline.filter((c) => isPerson(c.user.login)).length,
  };
};

/** The open PR whose head branch a stacked PR targets, if any. */
const basePr = (base) => {
  if (base === 'main') return undefined;
  const [pr] = gh(
    'pr',
    'list',
    '--head',
    base,
    '--state',
    'all',
    '--json',
    'number',
  );
  return pr?.number;
};

const describe = (pr) => {
  const checks = pr.checks
    .map((c) => `${c.name} ${c.done ? c.result : 'pending'}`)
    .join(', ');
  return `#${pr.number} ${pr.state} base=${pr.base} checks: ${checks || 'none'}; ${pr.title}`;
};

const changes = (before, after) => {
  const events = [];
  const n = `#${after.number}`;
  if (after.state !== before.state) {
    events.push(`${n} is ${after.state.toLowerCase()}`);
  }
  if (after.checksDone && (!before.checksDone || after.head !== before.head)) {
    const failed = after.checks.filter(
      (c) => !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.result),
    );
    events.push(
      failed.length === 0
        ? `${n}'s checks passed`
        : `${n}'s checks failed: ${failed.map((c) => `${c.name} ${c.result}`).join(', ')} ` +
            `(gh run view --log-failed, from gh pr checks ${after.number})`,
    );
  }
  if (after.feedback > before.feedback) {
    events.push(
      `${n} has ${after.feedback - before.feedback} new review(s) or comment(s) (gh pr view ${after.number} --comments, and gh api repos/${repo}/pulls/${after.number}/comments)`,
    );
  }
  return events;
};

const watched = new Map(numbers.map((n) => [n, snapshot(n)]));
const bases = new Map();
for (const pr of watched.values()) {
  const base = basePr(pr.base);
  if (base !== undefined && !watched.has(base)) bases.set(base, snapshot(base));
  console.log(describe(pr));
}
if (once) process.exit(0);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

for (;;) {
  await sleep(interval);
  const events = [];
  for (const [n, before] of watched) {
    const after = snapshot(n);
    events.push(...changes(before, after));
    watched.set(n, after);
  }
  for (const [n, before] of bases) {
    const after = snapshot(n);
    if (after.state === 'MERGED' && before.state !== 'MERGED') {
      const stacked = [...watched.values()].filter(
        (pr) => basePr(pr.base) === n,
      );
      events.push(
        `base #${n} is merged; rebase ${stacked.map((pr) => `#${pr.number}`).join(', ')} onto main (AGENTS.md, "Stacked pull requests")`,
      );
    }
    bases.set(n, after);
  }
  if (events.length > 0) {
    for (const event of events) console.log(event);
    process.exit(0);
  }
  if ([...watched.values()].every((pr) => pr.state !== 'OPEN')) process.exit(0);
}
