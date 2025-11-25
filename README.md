# Rhea Programming Language

Rhea is a new programming language targeting WebAssembly (WASM) and WASM-GC. It aims to be a familiar, statically-typed language similar to TypeScript but designed for ahead-of-time (AOT) compilation and high performance.

## Goals

- **WASM-First**: The primary and initial backend is WASM/WASM-GC.
- **Familiar Syntax**: Heavily inspired by TypeScript, making it easy to pick up for web developers.
- **Static & Optimizable**: Breaks away from JavaScript's dynamic semantics to allow for efficient AOT compilation and small binary sizes.
- **Functional & Object-Oriented**: Supports immutable classes, classical inheritance, and functional programming patterns.
- **Self-Hosted**: The long-term goal is for Rhea to be written in Rhea.

## Key Features

- **Variables**: `let` for immutable bindings, `var` for mutable bindings. Both are block-scoped.
- **Functions**: Arrow functions only (`=>`). No `function` keyword.
- **Classes**: Classical inheritance, immutable instances by default. Classes can be expressions.
- **Auto-Accessors**: Class fields generate auto-accessors backed by private storage by default.
- **Module System**: Similar to ES Modules. Standard library available via built-in modules.
- **Named Parameters**: First-class support for named parameters to avoid object allocation overhead.

## Getting Started

This project is currently in the bootstrapping phase. The initial compiler/parser is being written in TypeScript.

### Prerequisites

- Node.js
- npm

### Installation

(Instructions to be added)

## License

[MIT](LICENSE)
