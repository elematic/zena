---
title: 'Development'
description: 'How Zena is built, where it stands, how to contribute, and why the language is designed the way it is.'
---

Zena is developed in the open, and unusually: almost entirely by generative AI
under human review. This section is the record of how that works, what state the
project is in, and — at length — why the language ended up the way it did.

## How the project works

- **[Built with AI](/development/built-with-ai/)** — what "almost entirely" means
  in practice, how the loop actually runs, and what has gone wrong.
- **[Status and roadmap](/development/roadmap/)** — what works today, what's
  being built now, and what's deliberately not planned.
- **[Contributing](/development/contributing/)** — getting set up, finding your
  way around the repository, and what a change is expected to include.

## Why the language is like this

The **[Design](/development/design/)** pages take one decision at a time — why
[strings hide their encoding](/development/design/strings/), why iteration
[returns multiple values](/development/design/multi-value-returns/) instead of
allocating an `Option`, why unions
[restrict what can go in a union](/development/design/unions/), why
[primitives are never boxed implicitly](/development/design/automatic-boxing/),
and why
[regex is a library](/development/design/regex/).

Behind them are the working documents in
[`docs/design/`](https://github.com/elematic/zena/tree/main/docs/design),
written while a decision was being made and covering far more ground. They're
worth reading for the full argument, but the [reference](/reference/) is the
authority on what the language does today.

## Where to start

If you want to understand the project's reasoning, read
[Why Zena?](/guide/why-zena/) and then the [Design](/development/design/) pages.

If you want to work on it, read [Contributing](/development/contributing/) and
[`AGENTS.md`](https://github.com/elematic/zena/blob/main/AGENTS.md) — the
latter is the instruction file agents are given, and it doubles as the most
concise description of the project's standards.
