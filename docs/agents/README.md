# Agents on Zena

Most changes to this repository are written by coding agents (Claude Code,
Gemini) and reviewed by a person. This directory describes the checks that
catch the agents' mistakes, and the loop that adds a check, a tool or an
instruction when the same mistake shows up a second time.

## Checks

| When                          | What runs                                                                        | Defined in                                              |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| After each edit (Claude Code) | prettier on the edited file                                                      | `.claude/hooks/post-edit`, `.claude/settings.json`      |
| Before each push              | `npm run check`                                                                  | `scripts/check.js`, run by `scripts/git-hooks/pre-push` |
| While iterating               | `npm run test:quick -- <path>`, `npm run test:smoke`                             | AGENTS.md, "Running Tests"                              |
| On every pull request         | Format: `npm run format:check` and the Nix npm dependency hash; Test: `npm test` | `.github/workflows/test.yml`                            |

`npm run check` looks only at what the branch changed since it left
`origin/main`, and takes seconds:

- prettier, on the changed files CI's Format job checks;
- `zena lint`, on the changed lines of changed `.zena` files under
  `packages/`. CI does not lint, so this is stricter than CI on purpose:
  new code is held to the lint rules, and the findings already in a file
  are left for a cleanup PR;
- the `[package]` tags of commit subjects;
- the words listed in `<git common dir>/info/private-words`, a file outside
  the repository, so the list itself stays private.

Phrases that `docs/writing-style.md` asks prose to avoid are reported as
warnings. `npm ci` installs the pre-push hook by pointing `core.hooksPath`
at `scripts/git-hooks`; `git push --no-verify` skips it once.

When CI gains a check that takes seconds, add it to `scripts/check.js` too,
limited to the changed files, so an agent finds out before pushing rather
than twenty minutes after.

### Hooks in sessions started outside the repository

Claude Code reads `.claude/settings.json` only from the directory a session
starts in. On a machine where sessions start in a directory that holds
several worktrees, a user-level hook can find the repository of the file a
tool edited and run that repository's hook:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {"type": "command", "command": "~/.claude/hooks/repo-hook post-edit"}
        ]
      }
    ]
  }
}
```

where `~/.claude/hooks/repo-hook` reads the hook input, takes
`git rev-parse --show-toplevel` of the edited file's directory, and pipes
the input to `<root>/.claude/hooks/post-edit` when that file is executable
and the root is not the session's own project directory.

## After pushing

`npm run watch-prs -- <numbers>`, run as a background task, exits when one
of the PRs is merged or closed, when its checks finish, when someone other
than the agent account comments, or when the PR a stacked PR is based on
merges. The agent acts on what it printed and starts it again. In October
2026 about a third of the messages people sent to agents only passed on
this kind of GitHub state ("#n is merged, #m needs a rebase").

## The improvement loop

### Signals

A repeated mistake shows up in one of these places:

- a person's corrections in an agent session;
- review comments on pull requests;
- a PR whose first CI run fails;
- notes an agent keeps in its own memory (Claude Code's auto memory), which
  no other agent, harness or machine reads;
- patterns noticed during review and filed for later, as issues labelled
  `cleanup` (the `note` skill).

`scripts/agent-signals.py --since <date>` counts them for a period (it reads
Claude Code transcripts and, through `gh`, this repository's PRs) and saves
the messages behind each count for reading.

### Choosing a fix

Act on a pattern once it shows up in two separate sessions or PRs, and take
the first of these that is practical:

1. Remove the cause: fix the compiler, standard library or tool, or change
   an API so the mistake cannot be written.
2. Check it mechanically: a `zena-lint` rule whose message says what to
   write instead, a check in `scripts/check.js`, a test, a CI job.
3. Make the right way the easy way: a script or a skill.
4. Write it down: one line in AGENTS.md or the nearest CONTEXT.md, with a
   short example of the right code, placed where an agent will be reading
   when it matters.

An instruction that exists and is still broken calls for a step up the
list; repeating it louder does not work. When a check starts enforcing a
rule, delete the prose that stated it, since every always-loaded line costs
every session tokens.

Agent memory is a staging area. A note about this repository moves into the
repository once it has been useful twice, and notes that were wrong or have
moved are deleted.

### Ledger

Each fix gets a file in [`ledger/`](ledger/), named `YYYY-MM-DD-<slug>.md`,
so that concurrent PRs add files instead of editing one:

```markdown
# <What the fix addresses>

- Signal: <the repeated mistake, with counts and where they came from>
- Fix: <level 1–4 from the list above>, <PR>
- Watch: <the measure that should drop, and its value before the fix>
- Review: <date>
- Outcome: <filled in at review: the measure then, and what happens next>
```

### Weekly retro

The `retro` skill (`.claude/skills/retro/SKILL.md`, plain Markdown that any
agent can follow): run `scripts/agent-signals.py` for the week, read the
messages behind the counts, check the ledger entries due for review,
propose at most five fixes, and implement the ones the person approves,
each with a ledger entry.

### Reviewing the loop

Every fourth retro also reviews the loop itself, and edits the retro skill
and this file with what it finds:

- Ledger entries whose signal recurred after the fix: move each one step
  up the list in "Choosing a fix".
- Proposals the person rejected: what made each one wrong, and whether the
  threshold or the sources should change.
- The measures: whether each still tracks something worth changing. A
  measure changes only together with a note here, so that weeks stay
  comparable.
- The always-loaded context (AGENTS.md, the user-level instructions, the
  memory index): delete lines that a check now enforces or that no signal
  has needed.

## Measures

Computed by `scripts/agent-signals.py`. Baseline for the week of 2026-10-24
to 2026-10-31:

| Measure                                                    | Value                       |
| ---------------------------------------------------------- | --------------------------- |
| Messages from people that only relayed GitHub state        | 27 of 97 (28%)              |
| PRs whose first CI run failed                              | 5 of 111 (Format 4, Test 1) |
| `zena lint` findings in `.zena` files added under packages | 629 in 115 files            |
| Median tool calls before a new session's first edit        | 18                          |
| Mean context per API call                                  | 549k tokens                 |
| Bash calls that failed on a zsh glob (`no matches found`)  | 35                          |
