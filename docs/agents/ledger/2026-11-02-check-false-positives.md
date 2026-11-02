# Errors from `npm run check` that were not about the change

- Signal: two in the check's first two days. It rejected a branch that
  had merged `main` in, because a merge's subject has no package tags;
  another session hit it and fixed it (a6ed2109). And `--text`, used on a
  PR or issue description before filing it, also reported the branch's
  own lint findings, so its exit status said nothing about the text;
  #777 was filed after the check printed an error that turned out to be
  the branch's.
- Fix: level 2, merge commits skip the subject check, and `--text` checks
  only the text.
- Watch: commits that fix or bypass the check (`--no-verify`, edits to
  `scripts/check.js`), and corrections about it, in the weekly signals.
  An error that is not about the change teaches agents to skip the check.
- Review: 2026-11-28
- Outcome:
