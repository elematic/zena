#!/usr/bin/env node
/**
 * Waits until something happens to the given pull requests that the agent
 * who opened them should act on, prints what happened, and exits:
 *
 * - a PR is merged or closed;
 * - a PR's checks fail;
 * - someone other than the agent account reviews or comments;
 * - the PR a stacked PR is based on is merged, so the stacked PR needs
 *   rebasing onto main.
 *
 * Checks that pass are printed and the watch goes on, since there is
 * nothing to do about them; exiting there left a session that forgot to
 * restart it unaware of the merge that followed.
 *
 * Run it as a background task after pushing, so a merge or a red check
 * reaches the session without anyone relaying it, and start it again after
 * acting on what it printed. It prints the current state first, then polls.
 * A poll that GitHub fails is skipped, and five failures in a row end the
 * watch with an error.
 *
 *   npm run watch-prs -- [--interval <seconds>] [--minutes <n>] [--once] <pr>...
 *
 * After `--minutes` (default 110) with nothing to act on, it says so and
 * exits, to be started again: Claude Code stops a background task after two
 * hours without telling the session what it was waiting for, and a review
 * can take days. `--once` prints the current state and exits. Comments by
 * `elematic-bot` and by accounts whose login ends in `[bot]` are not
 * reported.
 */

import {execFileSync} from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback;
};
const interval = option('--interval', 90);
const minutes = option('--minutes', 110);
const once = args.includes('--once');
const numbers = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
if (numbers.length === 0) {
  console.error(
    'usage: npm run watch-prs -- [--interval s] [--minutes n] [--once] <pr>...',
  );
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
    if (failed.length === 0) {
      console.log(`${n}'s checks passed; still watching`);
    } else {
      events.push(
        `${n}'s checks failed: ${failed.map((c) => `${c.name} ${c.result}`).join(', ')} ` +
          `(gh run view --log-failed, from gh pr checks ${after.number})`,
      );
    }
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
/**
 * The PRs stacked on each base, as they were when the watch started: once
 * the base merges, GitHub may already have retargeted them to main.
 */
const stackedOn = new Map();
for (const pr of watched.values()) {
  const base = basePr(pr.base);
  if (base !== undefined && !watched.has(base)) bases.set(base, snapshot(base));
  if (base !== undefined) {
    stackedOn.set(base, [...(stackedOn.get(base) ?? []), pr.number]);
  }
  console.log(describe(pr));
}
if (once) process.exit(0);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * One poll: every PR's state now, compared with the last poll's. All of
 * them are read before any is compared, so a poll that GitHub fails
 * partway through changes nothing, and the next poll sees the same
 * differences.
 */
const poll = () => {
  const watchedNow = new Map([...watched.keys()].map((n) => [n, snapshot(n)]));
  const basesNow = new Map([...bases.keys()].map((n) => [n, snapshot(n)]));
  const events = [];
  for (const [n, after] of watchedNow) {
    events.push(...changes(watched.get(n), after));
    watched.set(n, after);
  }
  for (const [n, after] of basesNow) {
    if (after.state === 'MERGED' && bases.get(n).state !== 'MERGED') {
      for (const number of stackedOn.get(n) ?? []) {
        events.push(
          watchedNow.get(number).base === 'main'
            ? `base #${n} is merged and GitHub moved #${number} onto main; update the local branch (AGENTS.md, "Stacked PRs")`
            : `base #${n} is merged; rebase #${number} onto main (AGENTS.md, "Stacked PRs")`,
        );
      }
    }
    bases.set(n, after);
  }
  return events;
};

/**
 * GitHub answers a poll with a 502 now and then, and the next one works.
 * After this many failures in a row the watch gives up, since the cause
 * is likely one that waiting does not fix, such as an expired login.
 */
const FAILURES_ALLOWED = 5;
let failures = 0;

const deadline = Date.now() + minutes * 60_000;
for (;;) {
  await sleep(interval);
  let events = [];
  try {
    events = poll();
    failures = 0;
  } catch (error) {
    failures += 1;
    const reason = String(error.stderr || error.message).trim();
    if (failures >= FAILURES_ALLOWED) {
      console.log(`${failures} polls in a row failed; the last: ${reason}`);
      process.exit(1);
    }
    console.error(`a poll failed, trying again in ${interval}s: ${reason}`);
  }
  if (events.length > 0) {
    for (const event of events) console.log(event);
    process.exit(0);
  }
  if ([...watched.values()].every((pr) => pr.state !== 'OPEN')) process.exit(0);
  if (Date.now() > deadline) {
    for (const pr of watched.values()) console.log(describe(pr));
    console.log(
      `nothing to act on in ${minutes} minutes; start watch-prs again for ` +
        [...watched.values()]
          .filter((pr) => pr.state === 'OPEN')
          .map((pr) => pr.number)
          .join(' '),
    );
    process.exit(0);
  }
}
