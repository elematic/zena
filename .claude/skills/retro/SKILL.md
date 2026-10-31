---
name: retro
description: Weekly review of how agent sessions and PRs on Zena went - count repeated mistakes, check earlier fixes in docs/agents/ledger, and propose new checks, tools or instructions. Use when asked for a retro, or for what agents keep getting wrong.
---

# Retro

The loop this runs is described in `docs/agents/README.md`; read it first.
Work in your own worktree on a branch off `origin/main`.

## 1. Count

```bash
python3 scripts/agent-signals.py --since <last retro's date> --lint \
  --out .zena/agent-signals
```

The last retro's date is in the newest `docs/agents/retros/*.md`. Without
one, use seven days ago. The script takes a few minutes (most of it is
`gh`).

## 2. Read

Read `.zena/agent-signals/signals.json`: `corrections`, `relays` and
`review_comments`. The correction pattern is broad, so most matches are not
corrections; skip those. Group the rest by the mistake behind them, not by
wording. Also read:

- agent memory notes changed since the last retro
  (`ls -t ~/.claude/projects/*/memory/`), each a candidate to move into
  the repository or delete;
- open issues labelled `cleanup` (`gh issue list --label cleanup`);
- `docs/agents/ledger/` entries whose Review date has passed.

## 3. Check the ledger

For each entry due for review, compare its Watch measure with the value it
recorded, and fill in Outcome: the new value, and either "worked" or the
next step (one level up the list in "Choosing a fix"). Recurrence after a
fix is the most useful thing a retro finds.

## 4. Propose

List at most five fixes, most valuable first. Each needs:

- the mistake, with counts from at least two separate sessions or PRs, and
  one or two short quotes;
- where it is already covered (AGENTS.md, a CONTEXT.md, a lint rule, a
  memory note), since an existing rule that is broken needs a stronger
  fix rather than another line;
- the fix and its level, preferring a fix to Zena or a mechanical check
  over an instruction;
- the measure that should drop.

Also list instructions that a check now enforces and can be deleted.

Ask the person which to do (AskUserQuestion when available). Don't change
anything outside your worktree before they answer.

## 5. Record

Save the measures table, the proposals and the decisions as
`docs/agents/retros/YYYY-MM-DD.md`. Implement each approved fix as its own
PR with a ledger entry; quote no one by name in the repository, and run
`npm run check -- --text <PR description file>` before opening each PR.

## Every fourth retro

Also do "Reviewing the loop" in `docs/agents/README.md`, and edit this file
and the README with what changed. Look at how many proposals were accepted
in the last four retros: if most were rejected, ask why before proposing
more.
