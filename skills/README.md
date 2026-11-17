# Skills

Agent skills for writing Zena, in the
[Agent Skills](https://agentskills.io) layout: a directory with a `SKILL.md`
whose front matter says when to load it, and reference files it links to.

- [`zena/`](zena/SKILL.md): the language in brief, the features an agent
  trained on TypeScript tends to leave unused, the compiler's messages for
  common mistakes, and where to look things up.

Agents in other projects install it as a skill. In this repository
[`AGENTS.md`](../AGENTS.md) carries a copy of its main sections, since
every agent here writes Zena, a skill that has to be chosen is sometimes
not, and `AGENTS.md` is the one file every harness loads.

## Installing

Copy `skills/zena` into the directory your agent reads skills from. For
Claude Code that is `.claude/skills/zena` in a project, or
`~/.claude/skills/zena` for every project. The
[`skills`](https://github.com/vercel-labs/skills) command reads this
layout and does the copy for the agents it knows:

```sh
npx skills add elematic/zena
```

Then say in the project's `AGENTS.md` or `CLAUDE.md` that its `.zena`
files are Zena and that the skill is to be read before editing them. An
agent loads a skill only when it decides to, and that line is what makes
it decide.

## Changing a skill

Every `zena` code block in a skill is a complete library, and
`packages/zena-cli/tests/skill_test.zena` compiles each one. Write an
example as a block, so that it fails the build when the language moves, and
put a claim about a compiler message in a table only after running the
code. When a language change makes the skill wrong, change the skill in the
same pull request, and run `npm run skill` to update the copy of its
sections in `AGENTS.md`.
