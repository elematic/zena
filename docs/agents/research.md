# Approaches considered

What others have published about improving coding agents' first-attempt
results, as surveyed on 2026-10-31, and what this repository does about
each. "Next" and "later" items are where a retro looks when a measure stops
improving. Links and figures come from the survey; check a source before
relying on a number.

## Instructions and context files

- Gloaguen et al., ETH Zurich (2026, [arXiv 2602.11988](https://arxiv.org/abs/2602.11988)):
  on Python repositories, context files written by people raised task
  success by 4 points, generated ones lowered it by 3, and both raised cost
  by about 20%. Overviews of the repository did not help agents find files;
  instructions were followed. Advice: write only what an agent cannot find
  by reading the code.
- Vercel (Jan 2026, [blog](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)):
  for APIs newer than the model, an 8 KB docs index in AGENTS.md passed
  100% of their evals; a skill with the same docs passed 53%, because the
  agent did not load it in 56% of runs.
- "Syntax Without Semantics" (2026, [arXiv 2605.15607](https://arxiv.org/abs/2605.15607)),
  on a language absent from training data: 16.5% with the spec, 40.3% with
  worked code examples, 58% after one rule for the most common failure.
- McMillan (2026, [arXiv 2605.10039](https://arxiv.org/abs/2605.10039)),
  1,650 Claude Code sessions: file size and structure had no measurable
  effect on rule-following, but it fell about 5.6% for each further function
  the agent wrote in a session.
- OpenAI, "Harness engineering" (Feb 2026, [post](https://openai.com/index/harness-engineering/)):
  an AGENTS.md of about 100 lines that points into `docs/`, which is the
  record; their earlier long AGENTS.md drifted.

**Here:** Zena is the case these studies say context helps most, since the
model cannot infer the language. The idioms live in AGENTS.md's "Language
at a Glance" as code, which is always loaded, rather than in a skill that
might not load; its example was wrong and is fixed. Rules that people
repeated go in AGENTS.md as short lines. **Later:** cut AGENTS.md's
overview parts (the package list, the CLI reference) to a map, and measure
before and after.

## Learning from feedback

- ACE (2025, [arXiv 2510.04618](https://arxiv.org/abs/2510.04618)): a
  playbook of itemized entries, edited a few entries at a time with
  helpful/harmful counts. A full rewrite shrank one context from 18,282
  tokens to 122 and dropped accuracy below having no context.
- SkillsBench (2026, [arXiv 2602.12670](https://arxiv.org/abs/2602.12670)):
  curated skills helped (+4.5 points in software engineering, worse on 16
  of 84 tasks); skills a model wrote for itself averaged −1.3. Letta found
  skills built from trajectories plus feedback beat trajectories alone
  (+15.7 against +9).
- Cursor Bugbot's learned rules (Apr 2026, [post](https://cursor.com/blog/bugbot-learning)):
  candidate rules from reactions and replies, promoted after repeated
  evidence, disabled when they underperform. Greptile found that filtering
  comments similar to three or more rejected ones worked where prompting
  did not ([post](https://www.greptile.com/blog/make-llms-shut-up)).
- Every's compound engineering ([guide](https://every.to/compound-engineering/guides/ce-compound/)):
  one learning per task, written only if someone would otherwise repeat
  the investigation, with a condition for retiring it.
- Claude Code's `/insights` summarizes a month of friction; claude-reflect
  catches corrections with hooks and queues them for review.

**Here:** the weekly `retro` acts only on mistakes seen in two separate
sessions or PRs, records each fix with the measure it should move, and
checks the measure at a review date (`ledger/`). Fixes are small edits;
nothing rewrites AGENTS.md wholesale. **Later:** a hook that queues
corrections as they happen, if reading `agent-signals.py`'s broad matches
proves too slow.

## Measuring whether a change helped

- `claude plugin eval` runs cases with and without a plugin or skills
  directory, three trials each, and can replay a recorded session
  ([docs](https://code.claude.com/docs/en/plugin-evals)).
- Anthropic's evals guide distinguishes passing in any of k tries from
  passing in all k, and says to read transcripts to check graders.
- AGENTbench built its tasks from merged PRs that came with tests.

**Here:** `scripts/agent-signals.py` computes the same measures each week
from transcripts and GitHub. **Next:** a small eval suite of Zena tasks
taken from merged PRs (write the idiomatic version of a function, fix a
bug a test reproduces), run with and without an instruction change, so a
change to AGENTS.md can be tested before it lands.

## Mechanical enforcement

- OpenAI and Factory ([post](https://factory.com/using-linters-to-direct-agents))
  turn each repeated review finding into a lint rule whose message tells
  the agent what to write, run before commit and in CI.
- SlopCodeBench (2026, [arXiv 2603.24755](https://arxiv.org/abs/2603.24755)):
  structure eroded in 77% of agent trajectories; prompting for quality cut
  the initial mess by up to a third and did not slow the erosion.
- Notion's eslint-seatbelt ([post](https://www.notion.com/blog/how-we-evolved-our-code-notions-ratcheting-system-using-custom-eslint-rules))
  keeps per-file counts of allowed violations that may only go down.

**Here:** `npm run check` lints changed lines, so new code meets the rules
without fixing every old finding first. **Next:** a cleanup PR that runs
`zena lint --fix` over the existing findings, then `zena lint` in CI; a
check that a comment mentioning a workaround names an issue.

## Review and background agents

- Claude Code Review and the code-review plugin verify each finding before
  reporting and rank by severity; Amp runs one subagent per check file
  ([post](https://ampcode.com/news/liberating-code-review)), so every check
  is applied.
- GitHub's agentic workflows cap a duplicate-code scanner at three issues
  per run; 76 of 96 resulting PRs merged ([post](https://github.github.com/gh-aw/blog/2026-01-13-meet-the-workflows-continuous-simplicity/)).
  Anthropic's parallel C compiler had one agent whose only job was merging
  duplicated code ([post](https://www.anthropic.com/engineering/building-c-compiler)).
- When agents review agents, OpenAI found the reviewer had to be told to
  favor merging and flag only what blocks shipping, or the loop did not
  converge.

**Here:** the `note` skill files a pattern seen mid-task as a `cleanup`
issue. **Next:** a scheduled cleanup session that takes at most three
`cleanup` issues or duplicate-code findings per run, and a review agent
with one check per repeated mistake from the ledger ("works around a Zena
bug", "general code in a package", "duplicates the standard library").

## Slop in prose and code

- Wikipedia's "Signs of AI writing" lists the patterns, and notes that the
  giveaway words change with each model generation.
- Vale with the `voices` package or vale-llm-slop checks lexical and
  structural patterns, including comments that restate code;
  slop-forensics finds words over-represented against human text.
- GitClear (2025) measured copied code overtaking moved code; an analysis
  of 300k AI commits found 22.7% of the issues they introduced still
  present at HEAD.

**Here:** `npm run check` warns on phrases `docs/writing-style.md` rules
out. **Later:** derive this repository's own list by comparing agent-written
and person-written docs, and run Vale on changed Markdown and comments.

## Coordination between sessions

- Claude Code's cross-session messaging (`ListAgents`, `SendMessage`)
  delivers short messages between local sessions; a session can be named
  with `/rename` or `-n`. Sessions in different permission modes hold each
  other's messages for approval.
- MCP Agent Mail adds threads, file leases and search across Claude,
  Codex and Gemini; Beads keeps a dependency graph of tasks with atomic
  claims. Both report that search by keyword and recency is enough, and
  that lasting knowledge belongs in files.

**Here:** the native messaging, with named sessions, for "X landed, Y
changed"; GitHub issues and PRs for anything that should outlast a
session. Agent Mail is worth it only if Gemini or Codex sessions need to
coordinate with Claude sessions live.

## Memory, warm starts and session length

- Claude Code's auto memory is per machine and, by default, per project
  directory; cloud sessions, other harnesses and reviewers do not see it.
  VibeMemBench (2026) found memory that systems build for themselves did
  not beat having none in 11 of 12 pairings, while injecting verified
  experience helped.
- The prompt cache matches an exact prefix, which includes the working
  directory, so worktrees do not share cached prefixes. Forking a primed
  session saves its exploration only within the cache lifetime, carries
  a stale snapshot of the code, and costs that prefix on every later turn.

**Here:** facts about the repository move from memory into the repository.
No primed base session: the measured orientation cost (a median of 54
tool calls before the first edit) is mostly grep and partial reads of the
largest compiler files, which a fork would not remove for a new task.
Forking after a research or planning step, for its builds, does pay.

## Code navigation

- Claude Code's LSP plugins give agents diagnostics after every edit and
  a symbol tool ([docs](https://code.claude.com/docs/en/plugins/components#lsp-servers)).
  A 2026 study ([arXiv 2608.13568](https://arxiv.org/abs/2608.13568))
  found agents rarely chose the LSP to find code, and that it cost tokens
  there, but that it beat grep at finding every reference.
- Embedding search helps small models; for frontier models the gains are
  a few points, and Claude Code's team found agentic grep beat their early
  vector search.

**Next:** a Claude Code plugin that runs `zena-cli lsp`, for diagnostics
after each edit. **Later:** `references` and `workspace/symbol` in the
language server. No embedding index.

## Stacked pull requests

GitHub's stacked pull requests became generally available on 2026-10-06
([docs](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)):
merging a layer rebases and retargets the rest on the server, including
after squash merges, and `gh stack sync` does the same from the command
line. CI runs for every layer. git-spice is a free alternative.

**Here:** `watch-prs` tells the session when a base merges, and AGENTS.md
gives the rebase. **Next:** `gh stack`, which removes the rebase.

## Phases of work

- HumanLayer's research → plan → implement, keeping context use at 40–60%
  with deliberate compaction; their later version adds questions and a
  short spec before planning, because people skipped straight to plans.
- Anthropic's long-running harness: a progress file and a feature list
  that each session reads first, one feature at a time.
- Spec-driven tools (Spec Kit, Kiro) helped on feature tickets in one
  vendor benchmark and not on bug fixes; reviewers found the specs verbose.
- Claude Code's `/goal` repeats a task until a check passes.

**Later:** a research-and-plan skill, if retros show work going wrong for
lack of a plan; `/goal` for bug-fixing runs that a test can end.

## Local checks and CI

- Claude Code hooks can format after an edit, check before `git push`, or
  block finishing; git hooks cover every agent, and `--no-verify` skips
  them, so CI stays the gate.
- TDAD (2026, [arXiv 2603.17973](https://arxiv.org/abs/2603.17973)):
  telling an agent which tests cover the code it changed cut regressions
  from 6.1% to 1.8%; "use test-driven development" alone raised them.
- Of the 34 PRs whose first CI run failed from September to October 2026,
  20 failed on prettier.

**Here:** the edit hook and `npm run check`. **Later:** map changed paths
to the tests worth running locally (`test:quick` paths per package), in
the check's output.
