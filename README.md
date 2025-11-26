# Zena Programming Language

Zena is a new programming language targeting WebAssembly (WASM) and WASM-GC. It
is designed to be the **best way to write WASM**: offering a familiar, ergonomic
syntax similar to TypeScript, but with the performance and predictability of a
statically-typed, ahead-of-time (AOT) compiled language.

## Vision & Goals

Zena aims to be an extremely nice and familiar way to write high-performance
WASM. It balances familiar functional and OOP syntax with a strict orientation
around efficient WASM output.

- **WASM-First & High Performance**: The primary backend is WASM-GC. We aim for
  **no-cost to low-cost abstractions**, balancing performance with familiar OOP
  patterns. While we use vtables for polymorphism (a necessary tradeoff), we
  also aim to offer zero-cost alternatives where possible.
- **Familiar yet AOT**: While Zena looks like TypeScript, it is entirely
  designed for **ahead-of-time (AOT) compilation**. It breaks away from
  JavaScript's dynamic semantics to allow for efficient compilation and small
  binary sizes.
- **Modern Inspiration**: Zena aims to take inspiration and the best features
  from **TypeScript, Dart, C#, Kotlin, and Swift**.
- **Vibe Coding Experiment**: Zena is also an experiment in "vibe coding" a new
  programming language! We wouldn't have started a new language—it typically
  requires immense time and expertise—except that modern LLMs (like Gemini 3)
  are surprisingly adept at building them. We are exploring how far we can go
  with coding agents doing the heavy lifting.
- **Sound Type System**: Zena is strongly typed with a sound type system. It
  does not perform implicit type coercion (e.g., `1 + "1"` is a type error).
- **Correctness & Safety**: We prefer immutable data by default. Future plans
  include "branded types" for numeric values with units (e.g., `1m` or `10px`)
  to prevent logical errors.

## Key Features

> **Note**: Zena is in active development. Many of the features listed below are
> currently being implemented or are in the design phase.

- **Clean-Slate OOP**:
  - **JS-style private namespaces** (using `#`).
  - **Dart-style constructors** with initializer lists.
  - **Powerful mixins** for code reuse.
  - **Classical inheritance** with immutable instances by default.
- **Rich Type System**:
  - **Generics** and **Interfaces**.
  - **Future**: Union and intersection types, discriminated unions, and
    potentially mapped types.
- **High-Level Features**:
  - **Native JSX-like builder syntax**.
  - **Pattern matching**.
  - **Operator overloading** (possibly via extension methods) to support numeric
    programming (similar to R).
- **Variables**: `let` for immutable bindings, `var` for mutable bindings. Both
  are block-scoped.
- **Functions**: Arrow functions only (`=>`). No `function` keyword.
- **Auto-Accessors**: Class fields generate auto-accessors backed by private
  storage by default.
- **Efficient Standard Library**: A rich standard library that doesn't bloat
  binaries. Most features are opt-in via module imports, ensuring you only pay
  for what you use.
- **Named Parameters**: First-class support for named parameters to avoid object
  allocation ovezenad.

## Documentation

- [Language Reference](docs/language-reference.md): Detailed guide on syntax and
  semantics.

## Getting Started

This project is currently in the bootstrapping phase. The initial
compiler/parser is being written in TypeScript.

### Prerequisites

- Node.js
- npm

### Installation

(Instructions to be added)

## License

[MIT](LICENSE)
