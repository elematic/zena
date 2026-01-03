# Zena Project Instructions & Design

This document serves as a guide for the development of the Zena programming language.

## Project Overview

Zena is a statically typed language targeting WASM-GC. It uses a TypeScript-like syntax but enforces static semantics for better optimization.

## Design Principles

1.  **Performance**: Generated WASM should be fast. Avoid runtime ovezenad where possible (e.g., prefer flat arguments over object allocation for named parameters).
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
- **Soundness**: The type system is sound; if a program type-checks, it will not exhibit type errors at runtime.
- **No Coercion**: No implicit type coercion.
- **Inference**: Local variable types are inferred.
- **Advanced Types**:
  - **Type Aliases**: `type ID = string;`
  - **Distinct Types**: `distinct type Meters = i32;` (Nominal typing wrapper).
  - **Union Types**: `string | i32` (Supported in specific contexts like argument adaptation).

### Variables

- `let x = 1;` // Immutable binding.
- `var y = 1;` // Mutable binding.
- Block scoping.
- **Destructuring**: Supported for Records, Tuples, and Classes. `let {x, y} = point;`

### Control Flow

- **If**: `if (cond) { ... } else { ... }`
- **While**: `while (cond) { ... }`
- **For**: `for (var i = 0; i < 10; i = i + 1) { ... }` (C-style).

### Functions

- Only arrow syntax: `const add = (a: i32, b: i32) => a + b;`
- **Closures**: Functions capture variables from enclosing scopes.
- **Argument Adaptation**: Can pass functions with fewer arguments than expected.

### Classes & OOP

- **Classes**: `class Point { x: i32; #new(x: i32) { this.x = x; } }`
- **Inheritance**: `class Child extends Parent`.
- **Interfaces**: `interface Drawable { draw(): void; }`. Classes implement via `implements`.
- **Mixins**: `mixin Timestamped { time: i32; }`. Used via `class Log extends Base with Timestamped`.
- **Extension Classes**: `extension class ArrayExt on array<T> { ... }`. Adds methods to existing types.
- **Accessors**: Getters/Setters supported.
- **Visibility**: `#` prefix for private fields.

### Records & Tuples (Immutable)

- **Records**: `{ x: 1 }`. Immutable struct.
- **Tuples**: `[ 1, "a" ]`. Immutable struct.

### Mutable Collections

- **Maps**: `#{ key: value }`. Mutable Hash Map. (Class implemented, literal syntax `#{}` pending)
- **Arrays**: `#[ 1, 2 ]`. Mutable WASM GC Array.

### Strings

- **Literals**: `'text'` or `"text"`.
- **Template Literals**: `` `Value: ${x}` ``.
- **Tagged Templates**:
  ```
  tag`template`
  ```

### Modules

- ES Module syntax (`import`, `export`).

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
      4.  **Testing**: Compile Zena source to `Uint8Array`, instantiate with `WebAssembly.instantiate`, and assert results in Node.js.

### Phase 2: Self-Hosting

- Rewrite the compiler in Zena.
- Compile the Zena compiler using the Phase 1 TypeScript compiler.

### Phase 3: Ecosystem

- Standard Library implementation.
- Build tools / CLI.

## Project Structure

This project is an **npm monorepo** managed with **Wireit**.

- **Wireit Behavior**:
  - Wireit caches script results and only re-runs scripts when inputs change.
    Remember this when debugging or running tasks repeatedly.
  - You do not need to build before testing; Wireit handles dependencies
    automatically.
  - You NEVER need to delete build outputs manually; Wireit tracks
    inputs/outputs. If a script doesn't run because it was cached, its outputs
    remain unchanged. A passing test is still passing if it's skipped.
  - If you want to see more output for a script, set the WIREIT_LOGGER environment
    variable to `simple` (e.g., `WIREIT_LOGGER=simple npm test`).

- **Root**: Contains the workspace configuration and global scripts.
- **packages/compiler**: The core compiler implementation (`@zena-lang/compiler`).
- **packages/stdlib**: The Zena standard library implementation (`@zena-lang/stdlib`).
- **Scripts**:
  - `npm test`: Runs tests across the workspace using Wireit.
  - `npm run build`: Builds packages using Wireit.
  - **Running Tests**:
    - Use `npm test` or `npm test -w @zena-lang/compiler` to run all tests.
    - **Running Specific Tests**:
      - To run a specific test file, you MUST use the package workspace flag and pass the file path after `--`.
      - Example: `npm test -w @zena-lang/compiler -- test/checker/checker_test.js`
      - Do NOT try to pass arguments to the root `npm test` command (e.g. `npm test packages/compiler/...`), as they are ignored.
    - **NEVER** use `npm test packages/compiler` or `npm test -- some/path/some_test.ts`.
    - Packages are always referred to by **package name** (e.g., `@zena-lang/compiler`), not package path.
- ** Temporary Tests and Debug Scripts**: Create temporay test files in the
  normal test directories (e.g., `packages/compiler/src/test/`). Files in
  `/tmp/` will not be able to import project modules correctly.
  - Use the `--test-only` flag to isolate tests when debugging.
  - Use only `npm run`, `npm test`, or `node` to run scripts. Do NOT run scripts
    with `npx`, `tsx`, or `ts-node`.

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
  - Assertions should NOT be followed by conditionals that check the same thing. Assertions act as guards.
  - **Isolating Tests**: To isolate tests, pass the `--test-only` flag to Node and use `test.only()` in the test file.
  - **Codegen Tests**:
    - Use `compileAndRun(source, entryPoint?)` from `test/codegen/utils.ts` to compile and execute Zena code. It returns the result of the entry point function.
    - Use `compileAndInstantiate(source)` from `test/codegen/utils.ts` if you need access to all exports or need to test multiple functions from one source.
    - These utilities automatically provide standard library imports (like `console`) and handle the instantiation boilerplate.
- **Paradigm**: Prefer functional patterns where appropriate.
- **Package Management**: Prefer installing npm packages with `npm i <package>` instead of manually editing `package.json` to ensure valid versions.
- **Documentation**:
  - Record any new coding preferences, design choices, or architecture decisions in this file (`.github/copilot-instructions.md`).
  - Update `docs/language-reference.md` when language syntax or semantics change.
  - **Compiler Architecture**: Refer to `docs/design/compiler-architecture.md` for a detailed guide on the compiler's internals, key classes, and navigation.
  - Maintain design documents in `docs/design/` for complex features.
    - **Architecture**: `docs/design/compiler-architecture.md`
    - **Argument Adaptation**: `docs/design/argument-adaptation.md`
    - **Arrays**: `docs/design/arrays.md`
    - **Capabilities**: `docs/design/capabilities.md`
    - **Classes**: `docs/design/classes.md`
    - **Decorators**: `docs/design/decorators.md`
    - **Destructuring**: `docs/design/destructuring.md`
    - **Diagnostics**: `docs/design/diagnostics.md`
    - **Exceptions**: `docs/design/exceptions.md`
    - **Function Overloading**: `docs/design/function-overloading.md`
    - **Generics**: `docs/design/generics.md`
    - **Host Interop**: `docs/design/host-interop.md`
    - **Interfaces**: `docs/design/interfaces.md`
    - **Maps**: `docs/design/map.md`
    - **Mixins**: `docs/design/mixins.md`
    - **Modules**: `docs/design/modules.md`
    - **Optimization**: `docs/design/optimization-strategy.md`
    - **Records & Tuples**: `docs/design/records-and-tuples.md`
    - **Standard Library**: `docs/design/standard-library.md`
    - **Strings**: `docs/design/strings.md`
    - **Testing**: `docs/design/testing.md`
    - **Types**: `docs/design/types.md`
    - **Weak References**: `docs/design/weak-references.md`
    - **Runtime Type Tags**: `docs/design/runtime-type-tags.md`
    - **This Type**: `docs/design/this-type.md`

## Future Considerations

- **Strings & Unicode**: Currently, strings are UTF-8 bytes. We may want to change single-quotes `'` to represent a character/code-point type in the future, distinct from string literals. Unicode handling needs careful design.
- **Numeric Literals**:
  - **Defaults**: Revisit default types for literals. Consider making `f64` the default for floating-point literals (matching JS).
  - **Suffixes**: Implement syntax for numeric suffixes (e.g., `1L` for `i64`, `1f` for `f32`) to avoid verbose casting (`1 as i64`).

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
- [x] Implement Generics:
  - Generic Classes (`class Box<T>`).
  - Multiple Type Parameters (`class Pair<K, V>`).
  - Generic Functions (`<T>(x: T) => x`).
  - Type Inference (`new Box(10)` -> `Box<i32>`).
  - Default Type Parameters (`class Box<T = i32>`).
  - Inheritance (Basic):
    - `extends` keyword.
    - Struct layout compatibility.
    - Method/Field inheritance.
    - Static dispatch for overridden methods.
- [x] Implement Accessors (Parser, Checker, Codegen).
- [x] Implement `final` modifier (Parser, Checker, Codegen).
- [x] Implement Host Interop:
  - Imports (`declare`, `@external`).
  - Exports (Functions, Classes).
  - Standard Library (`Console`).
  - Runtime Helper.
  - Function Overloading.
- [x] Implement Closures:
  - Parser (Generic Arrow Functions).
  - Checker (Capture Analysis).
  - Codegen (Context Structs, \`ref.func\`, Element Section).
- [x] Implement Tagged Template Literals.
- [x] Implement Type Aliases (`type` keyword).
- [x] Implement Distinct Types (`distinct type` keyword).
- [x] Implement Function Types (`(a: i32) => void`).
- [x] Implement Records & Tuples:
  - Parser: Literals (`{...}`, `[...]`) and Types.
  - Checker: Structural typing and inference.
  - Codegen (Boxed): Canonical WASM structs.
  - Destructuring: Parser, Checker, Codegen.
- [x] Implement Optional Parameters:
  - Parser: `?` syntax.
  - Checker: Union with `null`, assignability.
  - Codegen: Default values.
- [x] Implement `eq` intrinsic and `operator ==` overloading.
- [x] Implement `Map` and `Box` in Standard Library.
- [x] Implement `hash` intrinsic.
- [x] Implement strict equality (`===`, `!==`).
- [x] Implement bitwise XOR (`^`), AND (`&`), OR (`|`).
- [x] Implement modulo operator (`%`).
- [x] Implement `i64` and `f64` support (Codegen & Emitter).
- [x] Allow identifiers to contain `$` and `_`.
- [x] Implement `#[ ... ]` array literal syntax.
- [x] Implement `map()` for `Array` and `FixedArray`.
- [x] Implement Pattern Matching (Basic):
  - `match` expression.
  - Identifier patterns (binding & wildcards).
  - Literal patterns (number, string, boolean).
  - Record patterns (`{x: 1}`).
  - Tuple patterns (`[1, 2]`) for Tuples.
  - Class patterns (`Point {x}`).
  - `as` patterns (`Point {x} as p`).
  - Logical patterns (`|`, `&`).
  - Match Guards (`case ... if ...`).
  - Exhaustiveness Checking.
- [x] Implement Record Spread (`{ ...p, z: 3 }`).
- [x] Implement Exceptions (`throw`).
- [x] Implement `never` type.
- [x] Implement Super Calls (`super(...)`, `super.method()`, `super.field`).
- [x] Implement Advanced Inheritance:
  - Virtual Fields (Uniform Access Principle).
  - Dynamic Dispatch (VTables).
  - Casting (`as`, `is`).
  - Mixins (Parser, Checker, Codegen).
- [x] Implement Interfaces:
  - Definition, Implementation, Inheritance.
  - Fat Pointers & VTables.
  - Interface Properties.
- [x] Implement Abstract Classes (`abstract` keyword, abstract methods).
- [x] Enforce Access Control (`#` private fields).
- [x] Implement Generic Constraints (`T extends Animal`).
- [x] Implement Blocks (Lexical Scoping).
- [x] Implement Type Narrowing (control-flow-based null checks).

### Planned

1.  **Type Checker Refactoring**:
    - **`ctx.currentClass` consistency**: Inside a generic class `Foo<T>`, `ctx.currentClass` should have `typeArguments = typeParameters` (i.e., represent `Foo<T>`, not just `Foo`). Currently, `checkThisExpression` creates a type with `typeArguments`, but `ctx.currentClass` doesn't have them, requiring a workaround in `isAssignableTo` to handle self-referential generic class comparisons. Fixing this at the source would eliminate that special case.
    - **Reject index assignment without `operator []=`**: Currently `x[0] = y` compiles even if the type only has `operator []` (getter). The checker should require `operator []=` for index assignment.
    - **Reject assignment to getter-only properties**: Currently `x.length = 5` compiles even if `length` only has a getter. The checker should require a setter for property assignment.

2.  **Host Interop**:
    - **WASM GC Interop Notes**:
      - WASM GC structs and arrays are OPAQUE from JavaScript.
      - JS cannot access struct fields or iterate GC arrays.
      - Use byte streaming (start/byte/end pattern) for string I/O.
      - See `docs/design/host-interop.md` for details.

3.  **Exceptions**:
    - **Try/Catch Statement Form**: Allow side-effect-only try/catch without requiring both branches to produce values. See `docs/design/exceptions.md` Open Questions.

4.  **Data Structures**:
    - **Maps**: Implement map literal syntax (`#{ key: value }`).
    - **Sets**: Implement mutable sets.

5.  **Standard Library**:
    - Math functions (`sqrt`, `abs`, etc.).
    - String manipulation (`substring`, `indexOf`).
    - Regexes.

6.  **Self-Hosting**:
    - Rewrite the compiler in Zena.

7.  **Pattern Matching (Advanced)**:
    - Array element matching (requires `FixedArray` support or `Sequence` interface).
    - Rest patterns (`...tail`).

8.  **Future Features**:
    - **Syntax**:
      - Blocks.
      - For/of loops.
      - Iterators.
      - JSX-like builder syntax.
    - **Type System**:
      - Numeric unit types.
      - Intersection types.
      - Enums.
      - Contextual typing for closures: Infer parameter types from context (e.g., `arr.map(x => x * 2)`). Requires parser support for `(a, b) =>` without type annotations, and checker support to propagate expected function type.
    - **OOP & Functions**:
      - Extension methods.
      - Operator overloading.
      - `operator is` overloading (zero-cost for non-overriders).
      - `TypeId<T>` intrinsic (compile-time type identifier).
      - Mixin constructors.
      - Async functions.
    - **Optimization**:
      - Compile-time constant expressions (string literals, immutable arrays, records/tuples, TemplateStringsArray as WASM constant globals instead of lazy initialization).
    - **Standard Library & Runtime**:
      - More operators: exponentiation.
      - Regexes.
      - Workers.
