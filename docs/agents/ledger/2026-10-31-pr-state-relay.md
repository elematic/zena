# People relaying GitHub state to agents

- Signal: 163 of 459 messages people sent to agents in October (36%), in
  25 sessions, only said that a PR had merged, needed a rebase, or failed
  a check. Stacked PRs had 64 of the 79 force-pushes in the last 150 PRs,
  most of them `rebase --onto` after the base PR was squash-merged.
- Fix: level 3, `npm run watch-prs` as a background task wakes the
  session on a merge, finished checks, a comment, or a merged base; the
  stacked-PR procedure is in AGENTS.md instead of one agent's memory.
- Watch: the share of relay messages (`agent-signals.py`); 28% in the
  week of 2026-10-24. Next step if it stays: GitHub's stacked PRs
  (`gh stack sync`), which rebase and retarget after a merge.
- Review: 2026-11-14
- Outcome:
