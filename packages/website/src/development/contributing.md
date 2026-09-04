---
title: 'Contributing'
description: 'How to build Zena from source, find your way around the repository, and open a change.'
---

Since you're reading this page, you might be looking for how to contribute to
Zena! First of all: thanks for your interest!

However, Zena is still very early in developemt, changing quite fast, and not
yet friendly to external contributors. We do want to get there as soon as
possible though.


Right now there are two major hurdles to easily accepting external code
contributions:

1. **Workflow transition and rapid churn.** Up until now, most development
   happened via pull requests on a local forge or direct commits to `main`.
   Issues were tracked in text documents or on the forge, and still CI runs
   locally. We are moving our workflow to GitHub, starting with issues, but
   GitHub CI needs to be configured and the workflow moved to public pull
   requests.
   
   In addition, development pace is very fast: major language design changes and
   repository reorganizations are still happening regularly. Many design docs
   are out of date. It's just a bit chaotic right now.
1. **AI-assisted contribution policy.** The project itself is written almost
   entirely by AI under human direction and review (see
   [Built with AI](/development/built-with-ai/)), so we do want to accept
   AI-assisted contributions. However, reviewing AI-generated code requires
   significant care, and we need to figure out how to handle it.
   
   In our own workflow, we know how we prompt, ensure agents read context files,
   understand our model's and harness's behavior, scrutenize as needed, and
   iterate through back-and-forth conversations. We cannot assume external pull
   requests arrive with comparable oversight, testing, and care. While any
   change should theoretically stand on its own merits, a widespread problem in
   open source right now is the imbalance between the minimal time required to
   generate a change and the substantial maintainer time required to review,
   verify, and debug it.
   
   We policy and guidelines to make this manageable, and we need to finish
   normalizing our workflow so contributors can follow it too. We will draw up a
   workable contribution policy soon.

## Feedback and discussion

In the meantime, the most valuable contributions are feedback, discussion, and
ideas. We are not (yet!) language design experts. We have tried to pick the best
features from several great languages and combine them in a consistent, coherent
way, but we have certainly gotten some things wrong.

Examples of the kinds of questions we have and would love feedback on include:

- Are there holes in the type system or pattern matching?
- Is the ownership model workable for real-world problems?
- What about the current complete lack of reflection and metaprogramming, and
  our plans for that?
- How do we best test our progress on our goals of execution performance and
  binary size?
- Is our strategy for working with different WebAssembly hosts viable?

To join the conversation:

- Join the `#zena` channel on the
  [WebAssembly Discord](https://discord.gg/r6gxeGkr5).
- Start or join a thread on
  [GitHub Discussions](https://github.com/elematic/zena/discussions).
- File bug reports or proposals on
  [GitHub Issues](https://github.com/elematic/zena/issues).

## Getting set up

If you want to check out the repository, experiment, and submit small pull
requests to fix small issues before our contribution policy lands, follow the
instructions below.

### Using Nix (recommended)

The repository provides a Nix flake that sets up the full environment:
Node.js (version 25+, satisfying the engine requirement for WASM exception
handling), `wasmtime`, `wasm-tools`, and the Rust toolchain needed to compile
`zena-cli`.

```bash
git clone https://github.com/elematic/zena.git
cd zena
direnv allow      # or: nix develop
npm ci
npm run build
npm test
```

### Manual setup

If you are not using Nix, make sure your environment provides:

- **Node.js 25 or newer**: Required for native WebAssembly exception handling
  (`exnref`).
- **Rust toolchain** (`cargo`, `rustc`): Required to build `packages/zena-cli`.
- **Wasmtime 47 or newer**: Required to run tests (such as component end-to-end
  tests) and execute compiled WebAssembly modules.
- **wasm-tools**: Required for component validation in the test suite and
  low-level WebAssembly inspection.

Once installed, build and test:

```bash
npm ci
npm run build
npm test
```

## Repository layout

An npm monorepo managed with [Wireit](https://github.com/google/wireit).

| Path                        | What it is                               |
| --------------------------- | ---------------------------------------- |
| `packages/zena-compiler`    | Self-hosted compiler, written in Zena    |
| `packages/zena-formatter`   | Zena formatter, written in Zena          |
| `packages/stdlib`           | Standard library                         |
| `packages/zena-cli`         | Native Rust CLI, runs Zena via Wasmtime  |
| `packages/runtime`          | JS runtime helpers                       |
| `packages/language-service` | Language server                          |
| `packages/website`          | This site                                |
| `packages/wit-parser`       | The WIT parser used by the compiler      |
| `tests/language/`           | Portable tests                           |
| `docs/design/`              | Design documents, written while deciding |

The compiler is **self-hosted**: written in Zena, running on Wasmtime via
`zena-cli`. See [Status and roadmap](/development/roadmap/).

## Tests and formatting

Portable tests in `tests/language/` are compiler-agnostic `.zena` files with
comment directives, in three categories:

| Directory    | Tests         | Directives                                          |
| ------------ | ------------- | --------------------------------------------------- |
| `syntax/`    | Parsing       | `// @target: module\|statement\|expression`         |
| `semantics/` | Type checking | `// @mode: check`, `// @error:` on failing lines    |
| `execution/` | Codegen       | `// @mode: run`, `// @result:` for the return value |

These tests don't use the `zena:test` test runner on purpose. A small runner can
be built in any langauge and the tests can be used to incrementally bring up a
new Zena compiler before it supports everything needed for `zena:test`.

**Prefer portable tests.** All new features and bugfixes should add portable
tests under `tests/language/`.

Standard library tests live in `packages/stdlib/

Formatting is Prettier, and CI checks it:

```bash
npm run format        # fix
npm run format:check  # verify
```

Formatting currently does *not* run the Zena formatter on Zena files.

## Working alongside agents

Most of the code here is generated (see [Built with
AI](/development/built-with-ai/)), which changes what's useful to contribute:

- **Write the decision down.** Non-obvious change should be noted in
  `docs/design/` explaining _why_. Undocumented decisions get re-litigated or
  quietly reversed by the next change.
- **Update `PLAN.md`, and file bugs as
  [issues](https://github.com/elematic/zena/issues).** They're the project's
  working memory, and agents read them for orientation.
- **Bug reports are especially valuable.** Plausible-but-wrong code is the main
  failure mode here, and a concrete reproduction is worth a lot more than a
  suspicion.
- **`AGENTS.md` is the conventions file.** If you change a convention, change it
  there too, or it won't stick.

## Opening a change

1. Branch from `main`.
2. Add or update portable tests in `tests/language/` where it applies.
3. `npm test` and `npm run format:check` clean.
4. For anything non-obvious, a `docs/design/` note.
5. Open a PR at [github.com/elematic/zena](https://github.com/elematic/zena).

Language design questions are best raised as an issue before writing code —
there's a good chance the answer is already in a design document, and a fair
chance the design is about to change.
