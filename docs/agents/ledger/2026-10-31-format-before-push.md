# Unformatted files reaching CI

- Signal: prettier failed the first CI run of 20 of the 34 PRs whose first
  run failed (2026-09-09 to 2026-10-31), 11 of them on Markdown alone; 7
  "Format" fix-up commits reached `main` after the Format job was split
  out. An agent memory note about it (2026-10-23) did not stop it
  recurring the next day.
- Fix: level 2, a Claude Code hook that formats each edited file and a
  pre-push check (`npm run check`).
- Watch: Format failures on PRs' first CI runs; 4 in the week of
  2026-10-24.
- Review: 2026-11-14
- Outcome:
