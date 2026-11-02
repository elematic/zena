# What agent memory knew that the repository did not

- Signal: an audit of the Claude Code memory notes about Zena (44 notes,
  599 claims, checked against `main` on 2026-11-02) found 452 claims
  fixed, stale, already documented or about finished work, and about 60
  still true and documented nowhere, several of them recorded because an
  agent made the same mistake more than once (integer `/`, editing
  inputs during a Wireit run, a stale `zena-cli`, `-f` filtering paths).
  It also found repository docs that were wrong: `Map.get`'s return type,
  a `--warn-unnecessary-casts` flag that does not exist, stage A's
  name section, and `rm -rf .wireit` in ir/CONTEXT.md against AGENTS.md.
- Fix: level 4, the lines every session needs in AGENTS.md and the
  corrections; the rest go into the CONTEXT.md and design documents
  nearest their code, and the memory notes are deleted or cut to what is
  specific to the dev VM once those land.
- Watch: the memory index's size (11.5 KB on 2026-11-02, loaded by every
  session), and whether these mistakes recur in the weekly signals.
- Review: 2026-11-28
- Outcome:
