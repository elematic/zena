---
title: 'Built with AI'
description: 'Zena is written almost entirely by generative AI under human review. What that means in practice, and what it has changed about the language.'
---

Zena's compiler, standard library, tooling, and this website were written almost
entirely by generative AI, with a human directing and reviewing. That isn't
decoration on an otherwise normal project — it changed what the language is.

## What "almost entirely" means

The human contribution is direction and review: what to build, which design to
take when there's a choice, and whether a change is actually correct. The code —
the compiler, the type checker, the code generator, the standard library, the
[design documents](/development/design/) — is generated.

Two consequences worth being explicit about:

- **This is an experiment with a real subject.** Zena has goals of its own; it
  isn't a demo of AI coding. But it is also a test of whether AI can produce
  software that holds up — not one impressive file, but a compiler that compiles
  itself, a stdlib with tests, and the surrounding ecosystem.
- **The review burden is the bottleneck**, not generation. That single fact
  explains most of the language's design decisions.

## How the loop works

The repository is set up so an agent can orient itself without being told:

- [`AGENTS.md`](https://github.com/elematic/zena/blob/main/AGENTS.md) is the
  instruction file — language conventions, project layout, how to run things. It
  doubles as the most concise description of the project's standards.
- [`PLAN.md`](https://github.com/elematic/zena/blob/main/PLAN.md) records
  what's done and what's next.
- [`BUGS.md`](https://github.com/elematic/zena/blob/main/BUGS.md) records
  known defects, including the ones the compiler has against itself.
- `docs/design/` holds a document per non-obvious decision, written _before_ or
  _while_ building it. The [Design](/development/design/) pages here are written
  up from them.
- `tests/language/` holds compiler-agnostic tests that both compilers must pass,
  so a change can be validated against an implementation-independent spec.

The design documents matter more than they look. A decision that only exists in
someone's head has to be rediscovered on every change; one written down can be
handed to the next agent as context. That's also why they're published rather
than kept internal.

## What the language does to help

Most of Zena's more opinionated choices are, at bottom, about making generated
code checkable:

- **Everything is typed, and the type system is sound.** A mistake the checker
  catches costs seconds. The same mistake reaching review costs human attention,
  and might not be caught at all.
- **No implicit coercion, no truthiness.** The most common class of plausible-
  looking-but-wrong generated code is a silent conversion. Zena makes those
  compile errors.
- **Exhaustive `match`.** Adding a case to a sealed hierarchy breaks every
  incomplete match, so the compiler produces the to-do list.
- **One obvious way to do things.** Ambiguity a person resolves from context
  becomes a wrong guess and a wasted iteration.
- **A conventional surface syntax.** Models write usable Zena from a short
  description because most of it is a language they've seen enormous amounts of.
  Novelty would cost accuracy for no benefit.
- **Fast compiles.** The loop is only as good as its slowest step.

The through-line: _do as much correctness checking with computers as possible,
because the human is the scarce resource._ Contracts and numeric unit types are
on the [roadmap](/development/roadmap/) for the same reason.

## What has gone wrong

Being honest about this is part of the point.

- **Plausible-but-wrong code is the main failure mode.** Generated code tends to
  compile and look reasonable while being subtly incorrect. Static checking
  catches a lot; tests catch more; neither catches everything, which is why the
  human review step is not optional.
- **The compiler has bugs against itself.** `BUGS.md` documents cases where the
  self-hosted compiler mishandles its own source — a module-graph dropout among
  them. Self-hosting is a good forcing function precisely because it surfaces
  these.
- **Design drift.** Without a written decision, successive changes wander. Most
  of `docs/design/` exists because something drifted first.
- **Confident wrong documentation.** Docs describing intent as though it were
  reality. There are almost certainly instances of this still on this site.

## What we have learned

- **Written-down decisions are the highest-leverage artifact.** More than clever
  code — they're what makes the next change cheap.
- **Self-hosting is worth the cost.** A compiler that compiles itself is a large,
  demanding, realistic test that runs on every change.
- **Language design and tooling design aren't separable here.** "Would this be
  checkable?" is a language question, and it's asked constantly.
- **Zero users is leverage.** Being able to change a decision in an afternoon is
  what makes this work at all; see
  [No users is a superpower](/guide/why-zena/#no-users-is-a-superpower).

## Working on it yourself

See [Contributing](/development/contributing/). Human contributions are welcome —
the project isn't AI-only by rule, it's AI-first by method.
