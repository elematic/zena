---
title: 'Contributing'
description: 'How to build Zena from source, find your way around the repository, and open a change.'
---

Zena is early, changing fast, and has no users to break — so contributions can
be ambitious. The tradeoff is that the ground moves under you.

## Getting set up

```bash
git clone https://github.com/elematic/zena.git
cd zena
npm install
npm run build
npm test
```

Node.js 25 or newer. `npm test` and `npm run build` work without anything else
installed.

For WASI testing and Wasm debugging you also need `wasmtime` and `wasm-tools`.
The repo ships a Nix flake with both:

```bash
direnv allow      # or: nix develop
```

::: tip Wasm GC flags
Wasmtime only enabled Wasm GC by default in version 47. On older versions, run
modules with the proposals turned on explicitly:

```bash
wasmtime run -W gc=y -W function-references=y -W exceptions=y --invoke main main.wasm
```

:::

## Repository layout

An npm monorepo managed with [Wireit](https://github.com/google/wireit).

| Path                        | What it is                               |
| --------------------------- | ---------------------------------------- |
| `packages/zena-compiler`    | Self-hosted compiler, written in Zena    |
| `packages/stdlib`           | Standard library                         |
| `packages/zena-cli`         | Native Rust CLI, runs Zena via Wasmtime  |
| `packages/runtime`          | JS runtime helpers                       |
| `packages/language-service` | Language server                          |
| `packages/website`          | This site                                |
| `tests/language/`           | Portable tests                           |
| `docs/design/`              | Design documents, written while deciding |

The compiler is **self-hosted**: written in Zena, running on Wasmtime via `zena-cli`.
See [Status and roadmap](/development/roadmap/).

## Tests and formatting

Portable tests in `tests/language/` are compiler-agnostic `.zena` files with
comment directives, in three categories:

| Directory    | Tests         | Directives                                          |
| ------------ | ------------- | --------------------------------------------------- |
| `syntax/`    | Parsing       | `// @target: module\|statement\|expression`         |
| `semantics/` | Type checking | `// @mode: check`, `// @error:` on failing lines    |
| `execution/` | Codegen       | `// @mode: run`, `// @result:` for the return value |

**Prefer portable tests.** All new features and bugfixes should add portable tests under `tests/language/`.

Formatting is Prettier, and CI checks it:

```bash
npm run format        # fix
npm run format:check  # verify
```

## Working alongside agents

Most of the code here is generated (see [Built with AI](/development/built-with-ai/)),
which changes what's useful to contribute:

- **Write the decision down.** A non-obvious change wants a note in
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
