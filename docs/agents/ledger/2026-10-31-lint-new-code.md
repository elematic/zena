# New code that the lint rules reject

- Signal: non-idiomatic Zena was the most frequent correction in October
  (26 in sessions and reviews, across 11 PRs: needless casts, `let` +
  `if` instead of an `if` expression, string concatenation, empty
  constructors). `zena-lint` already had rules for most of these, but
  nothing ran it: of 2,000 findings on `main`, 970 were in files added
  after 2026-10-17. AGENTS.md's own first example was a top-level
  `let f = (…) =>`, which the `function-declaration` rule rejects.
- Fix: level 2, `npm run check` fails on lint findings in changed lines;
  the AGENTS.md example now uses `function` declarations.
- Watch: `zena lint` findings in `.zena` files added under `packages/`
  (`agent-signals.py --lint`); 629 in 115 files in the week of
  2026-10-24. Next step if they stay: lint in CI, after a cleanup PR
  that runs `zena lint --fix` over the existing findings.
- Review: 2026-11-14
- Outcome:
