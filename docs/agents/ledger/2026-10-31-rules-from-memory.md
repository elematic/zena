# Rules that only one agent's memory held

- Signal: in sessions and reviews in October, people corrected agents for
  working around compiler bugs (16 times, 14 sessions and PRs), for
  putting general code in a package instead of the standard library
  (22 times), for keeping compatibility paths when Zena has no users
  (8), for writing tools in JavaScript or Rust (6), and for keying maps
  by offsets or ids (several). These rules existed only as Claude Code
  memory notes on one machine, which other harnesses, cloud sessions and
  the reviewer cannot see, and the workaround correction recurred after
  its note was written.
- Fix: level 4, AGENTS.md "Across the codebase".
- Watch: these themes among the corrections the weekly retro reads. A
  workaround is the one most likely to need a level 2 fix: a lint or
  check for `workaround` comments without an issue number.
- Review: 2026-11-28
- Outcome:
