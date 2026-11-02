# Rebasing stacked PRs by hand

- Signal: stacked PRs made 64 of the 79 force-pushes in the last 150 PRs
  (October 2026), most of them a `rebase --onto` after the PR below was
  squash-merged, and "#n needs a rebase" was a large part of the relay
  messages (`2026-10-31-pr-state-relay.md`).
- Fix: level 3, GitHub's stacked PRs through `gh stack link`, which rebase
  and retarget the rest of a stack on the server when a layer merges;
  `gh-stack` v0.3.0 is installed on the dev VM.
- Watch: force-pushes per stacked PR (1.56 in October), and "needs a
  rebase" messages in the weekly signals.
- Review: 2026-11-28
- Outcome:
