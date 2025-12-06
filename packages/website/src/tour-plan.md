# Zena Language Tour Plan

This document outlines the content for the Zena Language Tour page. The tour is designed to introduce new users to the language, starting from foundational concepts and progressing to advanced features.

## Introduction & Philosophy

- **Inspirations**:
  - **TypeScript**: Syntax familiarity, structural typing (where appropriate).
  - **Dart**: Class model, mixins, sound type system.
  - **Swift**: Extension classes, value types.
  - **Rust**: Expression-oriented control flow (`if`, `match`), immutability preferences.
- **Goals**:
  - **Easy to use**: Familiar syntax for JS/TS developers.
  - **Performance**: Statically compiled, optimized for WASM-GC.
  - **GC-based**: Automatic memory management (no manual `malloc`/`free` or borrow checker).
  - **WASM Native**: Designed specifically for the WebAssembly Garbage Collection proposal.

## 1. Basics & Variables

- **Hello World**: A simple entry point.
- **Comments**: Single-line `//` and multi-line `/* ... */`.
- **Variables**:
  - Immutable bindings with `let`.
  - Mutable bindings with `var`.
  - Block scoping.

## 2. Functions

- **Arrow Syntax**: All functions use `(args) => body`.
- **Type Annotations**: Parameter and return types.
- **Closures**: Capturing variables from enclosing scopes.
- **Optional Parameters**: Using `?` and default values.
- **Argument Adaptation**: Passing functions with fewer arguments.

## 3. Data Structures (Immutable)

- **Records**: Immutable structs `{ x: 1, y: 2 }`.
- **Tuples**: Immutable sequences `[1, "a"]`.
- **Destructuring**: Extracting values from Records and Tuples.
  - `let {x, y} = point;`
  - `let [a, b] = tuple;`

## 4. Types System

- **Primitive Types**: `i32`, `u32`, `f32`, `boolean`, `string`.
- **Type Inference**: `let x = 10;` (inferred as `i32`).
- **Type Aliases**: `type ID = string;`.
- **Distinct Types**: `distinct type Meters = i32;` (Nominal typing).
- **Union Types**: `string | null` (Reference types only).
- **The `any` Type**: Auto-boxing and explicit casting (`as`).
- **Nominal vs Structural**:
  - **Structural**: Records, Tuples, Functions (shape matters).
  - **Nominal**: Classes, Distinct Types (name/declaration matters).

## 5. Control Flow

- **Conditionals**:
  - `if` / `else` statements.
  - `if` as an expression: `let x = if (cond) 1 else 2;`.
- **Loops**:
  - `while` loops.
  - C-style `for` loops.
- **Exceptions**: `throw new Error(...)`.

## 6. Pattern Matching

- **Match Expression**: `match (x) { ... }`.
- **Patterns**:
  - Literals (`case 1:`).
  - Identifiers (`case x:`).
  - Wildcards (`case _:`).
  - Destructuring Patterns (Records, Tuples, Classes).
  - Logical Patterns (`|`, `&`).
- **Guards**: `case x if x > 10:`.

## 7. Object-Oriented Programming

- **Classes**:
  - Fields and Methods.
  - Constructors (`#new`).
  - Private Fields (`#field`).
  - Accessors (Getters/Setters).
- **Inheritance**: `class Child extends Parent`.
- **Interfaces**: `interface Drawable { ... }` and `implements`.
- **Mixins**: `mixin Timestamped { ... }` and `class ... with Timestamped`.
- **Extension Classes**: Adding methods to existing types (`extension class on ...`).
- **Modifiers**: `final`, `abstract`.
- **Generics**: Generic classes and methods (`class Box<T>`).

## 8. Collections & Strings

- **Arrays**:
  - Mutable arrays `array<T>`.
  - Literal syntax `#[1, 2, 3]`.
- **Maps**: Mutable `Map<K, V>`.
- **Strings**:
  - UTF-8 strings.
  - Template Literals: `` `Value: ${x}` ``.
  - Tagged Templates.

## 9. Advanced Features

- **Operator Overloading**:
  - Equality: `operator ==`.
  - Indexing: `operator []` and `operator []=`.
- **Modules**: `export`, `import`, `declare` (Host Interop).
