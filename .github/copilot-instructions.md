# Rhea Project Instructions & Design

This document serves as a guide for the development of the Rhea programming language.

## Project Overview

Rhea is a statically typed language targeting WASM-GC. It uses a TypeScript-like syntax but enforces static semantics for better optimization.

## Design Principles

1.  **Performance**: Generated WASM should be small and fast. Avoid runtime overhead where possible (e.g., prefer flat arguments over object allocation for named parameters).
2.  **Simplicity**: The language should be easy to parse and analyze.
3.  **Safety**: Strong static typing.

## Language Specification (Draft)

### Variables

- `let x = 1;` // Immutable binding (const in JS)
- `var y = 1;` // Mutable binding
- Block scoping applies to both.

### Functions

- Only arrow syntax: `const add = (a: i32, b: i32) => a + b;`
- Named parameters should be supported natively in the compiler to map to WASM function signatures efficiently.

### Classes

- Classical inheritance model.
- No mutable prototype chain.
- Classes are expressions.
- Fields imply auto-accessors.

### Modules

- ES Module syntax (`import`, `export`).
- No global namespace pollution; use imports for stdlib.

## Implementation Plan

### Phase 1: Bootstrapping (Current)

- **Language**: TypeScript (running on Node.js).
- **Goal**: Build a parser and a basic code generator that outputs WASM text format (WAT) or binary.
- **Components**:
  - Lexer/Tokenizer
  - Parser (AST generation)
  - Type Checker (Basic)
  - Code Generator (WASM-GC)

### Phase 2: Self-Hosting

- Rewrite the compiler in Rhea.
- Compile the Rhea compiler using the Phase 1 TypeScript compiler.

### Phase 3: Ecosystem

- Standard Library implementation.
- Build tools / CLI.

## Project Structure

This project is an **npm monorepo** managed with **Wireit**.

- **Root**: Contains the workspace configuration and global scripts.
- **packages/compiler**: The core compiler implementation (`@rhea-lang/compiler`).
- **Scripts**:
  - `npm test`: Runs tests across the workspace using Wireit.
  - `npm run build`: Builds packages using Wireit.
  - Use `npm test -w @rhea-lang/compiler` to run tests for a specific package.

## Coding Standards

- **TypeScript**: Use strict TypeScript. Write very modern (ES2024) TypeScript.
- **Erasable Syntax**: Do not use non-erasable syntax.
  - No `enum` (use `const` objects with `as const`).
  - No `namespace` (use ES modules).
  - No constructor parameter properties (e.g. `constructor(public x: number)`).
- **Variables**: Prefer `const`, then `let`. Avoid `var`.
- **Functions**: Always use arrow functions, unless a `this` binding is strictly required.
- **Formatting**:
  - Use single-quotes.
  - Use 2 spaces for indents.
  - No spaces around object literals and imports (e.g., `import {suite, test} from 'node:test';`).
- **Naming**:
  - File names should be `kebab-case`.
  - Test files should end in `_test.ts` (e.g., `lexer_test.ts`).
- **Testing**:
  - Use `suite` and `test` syntax from `node:test`.
  - Write tests for each compiler stage (Lexer, Parser, Codegen).
- **Paradigm**: Prefer functional patterns where appropriate.
- **Package Management**: Prefer installing npm packages with `npm i <package>` instead of manually editing `package.json` to ensure valid versions.
- **Documentation**: Record any new coding preferences, design choices, or architecture decisions in this file (`.github/copilot-instructions.md`).

## Next Steps

1.  Initialize npm project with TypeScript.
2.  Set up project structure (`src`, `tests`).
3.  Implement the Lexer.
