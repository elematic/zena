---
title: 'Status and Roadmap'
description: 'What works in Zena today, what is being built now, and what is deliberately not planned.'
---

Zena is **not ready for production use**. The compiler works and compiles itself,
but the language is still changing and will keep changing while
[nothing depends on it](/guide/why-zena/#no-users-is-a-superpower).

The authoritative version of this page is
[`PLAN.md`](https://github.com/elematic/zena/blob/main/PLAN.md) in the
repository; this is a summary.

## Where things stand

| Area                            | Status                                          |
| ------------------------------- | ----------------------------------------------- |
| Wasm GC code generation         | <span class="badge tip">Working</span>          |
| Bootstrap compiler (TypeScript) | <span class="badge tip">Complete</span>         |
| Self-hosted compiler            | <span class="badge tip">Passes all tests</span> |
| ZIR optimizing backend          | <span class="badge warning">In progress</span>  |
| Async functions, WASI P3        | <span class="badge info">Planned</span>         |
| Component model and WIT         | <span class="badge warning">In progress</span>  |
| Package manager                 | <span class="badge info">Planned</span>         |
| Playground                      | <span class="badge info">Planned</span>         |

Working today: arrow functions and closures, records and tuples with unboxed
multi-value returns, fixed and growable arrays, monomorphized generics with no
auto-boxing, single inheritance with abstract classes, mixins and interfaces,
exhaustive pattern matching with guards and pattern conditions, Wasm GC exception
handling, dead-code elimination over functions and types, and a standard library
covering strings, collections, JSON, regex, and file I/O.

## What is next

**Retire the bootstrap compiler.** The self-hosted compiler already passes the
syntax, language, and execution suites. Finishing means completing the new
IR-based backend — which is also what unlocks devirtualization, specialization,
and further size reductions — and resolving known performance problems, notably
quadratic function lookups in the code generator and sharing specialized methods
across reference-type instantiations so monomorphization costs less binary size.

→ [ZIR: an optimizing IR](https://github.com/elematic/zena/blob/main/docs/design/ir.md) ·
[Self-hosted compiler](https://github.com/elematic/zena/blob/main/docs/design/self-hosted-compiler.md)

## Further out

**Async and cooperative multithreading**, targeting the upcoming Wasm P3
features. → [Concurrency](https://github.com/elematic/zena/blob/main/docs/design/concurrency.md)

**Component model and WIT.** A WIT parser and bindings generator so Zena
programs import and export WIT interfaces directly and compile to compliant
components, with no external bindgen step.
→ [WASI support](https://github.com/elematic/zena/blob/main/docs/design/wasi.md) ·
[WIT parser](https://github.com/elematic/zena/blob/main/docs/design/wit-parser.md)

**Tooling.** A package manager, the in-browser playground, and deeper VS Code
integration.

**Headline language features**, the ones that go beyond catching up with
TypeScript:

- **Numeric unit types** — statically verified units of measure, so adding meters
  to feet is a compile error. → [Scientific computing](https://github.com/elematic/zena/blob/main/docs/design/scientific-computing.md)
- **Contracts** — `requires` and `ensures`, checked at runtime now and
  candidates for static verification with SMT solvers later.
  → [Formal verification](https://github.com/elematic/zena/blob/main/docs/design/formal-verification.md)
- **SIMD** — native Wasm vector instructions.
- **Decorators and macros** — compile-time code generation.
  → [Macros](https://github.com/elematic/zena/blob/main/docs/design/macros.md) · [Decorators](https://github.com/elematic/zena/blob/main/docs/design/decorators.md)

## What is not planned

Worth stating, because their absence is a design decision rather than a gap:

- **Automatic boxing of primitives**, or an `any` type that would require it.
  → [why](/development/design/automatic-boxing/)
- **Unions mixing primitives with references.**
  → [why](/development/design/unions/)
- **A garbage collector of our own.** The host's collector is the point.
- **Linear-memory-only builds.** Zena targets Wasm GC and assumes it.
- **Implicit numeric coercion, or truthiness.**

## Following along

Development happens in the open at
[github.com/elematic/zena](https://github.com/elematic/zena).
[`BUGS.md`](https://github.com/elematic/zena/blob/main/BUGS.md) tracks known
defects, including ones the compiler currently has against itself.
