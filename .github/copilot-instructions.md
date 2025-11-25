# Rhea Project Instructions & Design

This document serves as a guide for the development of the Rhea programming language.

## Project Overview

Rhea is a statically typed language targeting WASM-GC. It uses a TypeScript-like syntax but enforces static semantics for better optimization.

## Design Principles

1.  **Performance**: Generated WASM should be fast. Avoid runtime overhead where possible (e.g., prefer flat arguments over object allocation for named parameters).
2.  **Binary Size**: The compiler should produce the smallest possible WASM binary. This is critical for network delivery.
    - _Trade-off_: When Performance and Binary Size conflict (e.g., Monomorphization vs Erasure), we currently favor **Performance**, but this is a tunable design choice.
3.  **Simplicity**: The language should be easy to parse and analyze.
4.  **Safety**: Strong static typing with a sound type system. No implicit type coercion.
5.  **Minimal Output**: Standard library components (like `Map`) should only be included in the output if they are actually used by the program (Dead Code Elimination).

## Language Specification

The official language reference is maintained in `docs/language-reference.md`.
**Instruction**: When adding or modifying language features, you MUST update `docs/language-reference.md` to reflect the changes.

### Type System

- **Strongly Typed**: All expressions have a static type determined at compile time.
- **Soundness**: The type system is sound; if a program type-checks, it will not exhibit type errors at runtime (barring unsafe blocks, if added later).
- **No Coercion**: Unlike JavaScript, Rhea does not perform implicit type coercion. Operations between mismatched types (e.g., adding an integer to a string) result in a compile-time error.
- **Inference**: Local variable types are inferred from their initializer.

### Variables

- `let x = 1;` // Immutable binding (const in JS). Type inferred as `i32`.
- `var y = 1;` // Mutable binding
- Block scoping applies to both.

### Functions

- Only arrow syntax: `const add = (a: i32, b: i32) => a + b;`
- Named parameters should be supported natively in the compiler to map to WASM function signatures efficiently.

### Classes

- **Implementation**: Classes are backed by WASM GC Structs (fixed layout, typed fields).
- **Syntax**: Standard class syntax defines the struct layout.
- **Instantiation**: Class instances are created using constructors (e.g., `new Point(1, 2)`). Object literals `{ ... }` are reserved for Records.
- Classical inheritance model.
- No mutable prototype chain.
- Classes are expressions.
- Fields imply auto-accessors.

### Records & Tuples (Immutable - Default)

- **Records**: `{ x: 1, y: 2 }`. Creates an **immutable** anonymous struct. This is the default for object literals.
- **Tuples**: `[ 1, "hello" ]`. Creates an **immutable** fixed-length struct with indexed fields. This is the default for array literals.
- **Implementation**: Backed by immutable WASM GC Structs.

### Mutable Collections (Maps & Arrays)

- **Maps**: `#{ key: value }`. Creates a mutable Map (Hash Map).
- **Arrays**: `#[ 1, 2, 3 ]`. Creates a mutable Array (WASM GC Array).
- **Implementation**: Backed by Hash Maps and WASM GC Arrays respectively.

### Modules

- ES Module syntax (`import`, `export`).
- No global namespace pollution; use imports for stdlib.

## Implementation Plan

### Phase 1: Bootstrapping (Current)

- **Language**: TypeScript (running on Node.js).
- **Goal**: Build a parser and a basic code generator that outputs WASM text format (WAT) or binary.
- **Components**:
  - Lexer/Tokenizer (Done)
  - Parser (AST generation) (Done)
  - Type Checker (Basic) (Done)
  - Code Generator (WASM-GC)
    - **Strategy**: End-to-End Execution Testing.
    - **Steps**:
      1.  **Parser Update**: Support `export` keyword for top-level declarations to expose functions to the host.
      2.  **WASM Emitter**: Implement a low-level `emitter.ts` to construct WASM binary sections (Type, Function, Export, Code).
      3.  **Code Generator**: Implement `codegen.ts` to traverse AST and drive the emitter. Initial scope: `i32` arithmetic and function parameters.
      4.  **Testing**: Compile Rhea source to `Uint8Array`, instantiate with `WebAssembly.instantiate`, and assert results in Node.js.

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
  - No `private` keyword (use `#` private fields).
- **Variables**: Prefer `const`, then `let`. Avoid `var`.
- **Functions**: Always use arrow functions, unless a `this` binding is strictly required.
- **Formatting**:
  - Use single-quotes.
  - Use 2 spaces for indents.
  - No spaces around object literals and imports (e.g., `import {suite, test} from 'node:test';`).
- **Naming**:
  - File names should be `kebab-case`.
  - Test files should end in `_test.ts`. The prefix should be `kebab-case` (e.g., `generics-parser_test.ts`, not `generics_parser_test.ts`).
- **Testing**:
  - Use `suite` and `test` syntax from `node:test`.
  - Write tests for each compiler stage (Lexer, Parser, Codegen).
  - New syntax features MUST have dedicated parser tests (and lexer tests, if new tokens are introduced).
- **Paradigm**: Prefer functional patterns where appropriate.
- **Package Management**: Prefer installing npm packages with `npm i <package>` instead of manually editing `package.json` to ensure valid versions.
- **Documentation**:
  - Record any new coding preferences, design choices, or architecture decisions in this file (`.github/copilot-instructions.md`).
  - Update `docs/language-reference.md` when language syntax or semantics change.
  - Maintain design documents in `docs/design/` for complex features (e.g., `docs/design/strings.md`).

## Future Considerations

- **Strings & Unicode**: Currently, strings are UTF-8 bytes. We may want to change single-quotes `'` to represent a character/code-point type in the future, distinct from string literals. Unicode handling needs careful design.

## Next Steps

### Completed

- [x] Initialize npm project with TypeScript.
- [x] Set up project structure (`src`, `tests`).
- [x] Implement the Lexer.
- [x] Implement Parser (AST generation).
- [x] Implement Type Checker (Basic).
- [x] Implement Code Generator (WASM-GC) for:
  - `i32` arithmetic.
  - Function parameters.
  - `while` loops.
  - `if` statements.
  - Variable assignment (`var`).
  - Function calls and recursion.
- [x] Implement Structs & Classes (WASM-GC structs).
- [x] Implement Arrays (WASM-GC arrays).
- [x] Implement Strings (UTF-8 bytes, concatenation, equality).

### Planned

1.  **Maps**: Implement mutable maps (`#{ key: value }`).
2.  **Standard Library**: Begin building a small standard library (math, string manipulation).
3.  **Self-Hosting**: Rewrite the compiler in Rhea.
