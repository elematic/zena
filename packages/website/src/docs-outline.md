# Zena Documentation Outline

This document outlines the planned documentation structure for the Zena website.
Status indicators: ✅ Implemented | 🚧 Partially implemented | 📝 Designed | 🔮 Future work

---

## Site Structure Overview

```
/                           Home page (overview, features, examples)
/docs/                      Documentation landing page
/docs/quick-reference/      One-page language reference
/docs/guide/                Language guide (detailed reference by topic)
/docs/wasm/                 How Zena translates to WASM
/docs/for-X-developers/     Migration guides
/docs/wasi/                 WASI integration
```

---

## 1. Home Page (Existing)

The home page already covers the high-level overview. Minor additions:

- [ ] Brief "Why Zena?" section emphasizing WASM-first design
- [ ] Code comparison snippet (Zena vs equivalent TypeScript)
- [ ] Link to one-page reference

---

## 2. One-Page Language Reference ⭐ PRIORITY

**Goal**: A single-page reference covering every language feature with concise explanations and examples. Detailed enough to be useful, brief enough to scan quickly. Think "cheat sheet meets tutorial."

### 2.1 Introduction

- What is Zena? (2-3 sentences)
- Quick start example (Hello World → compile → run)
- WASM target: `--target host` vs `--target wasi`

### 2.2 Basic Syntax

- Comments: `//` and `/* */`
- Identifiers and naming conventions
- Semicolons (optional in many contexts)

### 2.3 Variables

- `let` = immutable binding ✅
- `var` = mutable binding ✅
- Type inference ✅
- Explicit type annotations ✅

### 2.4 Primitive Types

- Integers: `i32`, `i64`, `u32` ✅
- Floats: `f32`, `f64` ✅
- `boolean`, `string` ✅
- `anyref`, `any` ✅
- `never` ✅
- `ByteArray` (low-level) ✅

### 2.5 Functions

- Arrow syntax: `(params) => body` ✅
- Type annotations on parameters and return ✅
- Block bodies vs expression bodies ✅
- Closures ✅
- Generic functions ✅
- Optional parameters (`?`) ✅
- Default parameters ✅
- Argument adaptation ✅
- Function overloading 🚧

### 2.6 Operators & Expressions

- Arithmetic: `+`, `-`, `*`, `/`, `%` ✅
- Comparison: `==`, `!=`, `<`, `>`, `<=`, `>=` ✅
- Logical: `&&`, `||`, `!` ✅
- Bitwise: `&`, `|`, `^`, `~`, `<<`, `>>` ✅
- Assignment: `=` ✅
- Type cast: `as` ✅
- Type check: `is` ✅
- Range: `..`, `..=` ✅
- Pipeline: `|>` 🔮

### 2.7 Control Flow

- `if`/`else` statements and expressions ✅
- `while` loops ✅
- C-style `for` loops ✅
- `for-in` loops (iteration) ✅
- `break` and `continue` ✅
- `match` expressions ✅
- Pattern guards (`case x if condition:`) ✅

### 2.8 Pattern Matching

- Literal patterns ✅
- Identifier patterns ✅
- Wildcard `_` ✅
- Tuple destructuring ✅
- Record destructuring ✅
- Class destructuring ✅
- Or patterns (`|`) ✅
- Exhaustiveness checking ✅

### 2.9 Strings

- String literals (double quotes) ✅
- Template literals ✅
- String interpolation `${expr}` ✅
- Escape sequences ✅
- Tagged templates ✅
- Encoding abstracted away (WTF-8 or WTF-16 internally) ✅
- Unicode code point iteration ✅
- `StringBuilder` for efficient construction ✅
- `StringReader` for efficient parsing 🚧

### 2.10 Type System

- Type inference ✅
- Type annotations ✅
- Type aliases (`type`) ✅
- Distinct types (`distinct type`) ✅
- Union types (`A | B`) ✅
- Literal types ✅
- Function types ✅
- Generic types ✅
- Type narrowing (control flow analysis) ✅
- Nominal vs structural typing ✅

### 2.11 Enums

- Declaration syntax ✅
- Integer-backed enums ✅
- String-backed enums ✅
- Type safety (distinct from underlying type) ✅

### 2.12 Records & Tuples

- Record literals: `{x: 1, y: 2}` ✅
- Tuple literals: `[1, "a"]` ✅
- Shorthand syntax: `{x, y}` ✅
- Spread syntax: `{...other, x: 1}` ✅
- Destructuring ✅
- Structural typing ✅
- Unboxed tuples (multi-value returns) ✅

### 2.13 Classes

- Declaration and fields ✅
- Constructor (`#new`) ✅
- Methods ✅
- Private fields (`#field`) ✅
- Getters and setters ✅
- Auto-accessors 🚧
- Inheritance (`extends`) ✅
- Generic classes ✅
- Generic methods ✅
- Static members ✅
- `abstract` and `final` modifiers ✅
- Extension classes ✅

### 2.14 Interfaces

- Declaration ✅
- `implements` ✅
- Multiple interfaces ✅
- Generic interfaces ✅
- Interface inheritance ✅

### 2.15 Mixins

- Declaration (`mixin`) ✅
- `with` clause ✅
- Mixin composition ✅

### 2.16 Arrays & Collections

- `FixedArray<T>`: fixed-size array ✅
- `Array<T>`: growable array ✅
- Array literals: `#[1, 2, 3]` ✅
- Slicing with ranges: `arr[a..b]` 🚧
- `Map<K, V>` ✅
- Iteration protocol ✅
- `for-in` loops ✅

### 2.17 Boxing

- `Box<T>` for primitives ✅
- Auto-boxing with `any` ✅
- Manual boxing ✅

### 2.18 Exception Handling

- `throw` expressions ✅
- `Error` class ✅
- `try`/`catch` 🚧
- `try`/`finally` 🚧

### 2.19 Modules & Exports

- `export` declarations ✅
- Host imports (`import ... from "host"`) ✅
- Module system 🚧

### 2.20 Intrinsics & Decorators

- `@intrinsic` ✅
- `@pure` ✅
- `operator ==` ✅
- `operator hash` ✅

---

## 3. How Zena Translates to WASM ⭐ PRIORITY

**Goal**: Show developers exactly how Zena constructs map to WASM, with code examples. Essential for understanding performance characteristics.

### 3.1 Introduction

- Why understanding the translation matters
- WASM-GC primer (brief)
- Reading WASM text format basics

### 3.2 Primitives

- `i32`, `i64`, `f32`, `f64` → WASM value types directly
- No boxing, no indirection
- Example: arithmetic operations

### 3.3 Functions

- Zena functions → WASM functions
- Direct calls (`call`) vs indirect calls (`call_indirect`)
- Closures → WASM structs + `call_indirect`

### 3.4 Classes

- Class → WASM-GC struct
- Methods → functions with implicit `this` parameter
- Virtual dispatch → vtables + `call_indirect`
- When devirtualization happens → direct `call`
- Example: class hierarchy, method call

### 3.5 Generics

- Monomorphization: `Box<i32>` and `Box<string>` are different WASM types
- Performance implications (no boxing, no casts)
- Binary size implications (code duplication)

### 3.6 Records & Tuples

- Records → WASM-GC structs (with structural type)
- Tuples → WASM-GC structs
- Unboxed tuples → multiple WASM return values (stack, not heap)

### 3.7 Interfaces & Vtables

- Interface values → fat pointers (object ref + vtable ref)
- Interface method calls → vtable lookup + `call_indirect`
- Memory layout diagram

### 3.8 Arrays

- `FixedArray<T>` → WASM-GC array (fixed size, no reallocation)
- `Array<T>` → growable array (wrapper around FixedArray with capacity management)
- Slicing: `arr[a..b]` uses Range to create a view
- Bounds checking
- Memory layout
- When to use each type

### 3.9 Strings

- One `String` type, multiple internal implementations
- `GCString` (default), `LinearString` (WASI I/O), `HostString` (JS DOM), `LiteralString` (data segment)
- Encoding: WTF-8 (compact) vs WTF-16 (JS interop)
- Why WTF (Wobbly) not UTF: lossless JS round-tripping
- `--default-encoding` compiler flag
- View-based design: O(1) zero-copy `slice()`
- Memory retention tradeoff (like Go)
- `copy()` to release parent memory
- `StringBuilder` and `StringReader`

### 3.10 Closures & Function References

- Closure environment → struct
- Function reference → `funcref` + environment
- Calling overhead

### 3.11 Exception Handling

- WASM exception handling proposal
- `throw` → `throw`
- `try`/`catch` → WASM try/catch

### 3.12 Performance Considerations

- Cost of abstractions
- When to prefer direct calls (final methods, non-virtual)
- Boxing costs
- IC (inline caching) in WASM VMs
- Tips for writing fast Zena code

---

## 4. Language Guide (Detailed Reference by Topic)

Individual pages with comprehensive coverage of each feature.

### 4.1 Philosophy & Goals

- WASM-GC first design (not linear memory like Rust/C++)
- Why GC: ergonomics, interop with host GC (JS), no borrow checker complexity
- Performance and binary size priorities
- Familiarity vs fixing historical PL mistakes
- Inspiration: TypeScript, Swift, Dart, Go, Rust
- Host integration design (JS, WASI, strings)
- Safety and correctness (sound types, distinct types, no unchecked casts)
- Future: contracts, formal methods

### 4.2 AI-Optimized Language Design 📝

(Based on docs/design/ai-first-language.md)

- Static typing for agent feedback loops
- Unusually helpful error messages
- MCP/LSP integration
- Contracts and formal methods (future)
- Sandboxed execution via WASM
- Rich standard library for consistent patterns

### 4.3 Optimized for the Web 📝

- Small binary size is paramount
- JS integration
- DOM bindings (future)

### 4.4 Modules 🚧

- Module system design
- Import/export
- Visibility

### 4.5 Variables (detailed)

- Immutability philosophy
- Shadowing rules
- Block scoping details

### 4.6 Data Types (detailed)

- Numeric type semantics
- Precision and overflow
- Signed vs unsigned
- Float special values (NaN, Infinity)

### 4.7 Functions (detailed)

- Argument adaptation internals
- Contextual type inference
- Overload resolution
- Performance of different call patterns

### 4.8 Expressions & Operators (detailed)

- Operator precedence table
- Short-circuit evaluation
- Pipeline operator (future)

### 4.9 Control Flow (detailed)

- Expression-oriented design
- Optional semicolons rules
- Pattern matching exhaustiveness

### 4.10 Strings (detailed)

- Unified String architecture (one type, multiple implementations)
  - `GCString`: Default for literals, concatenation
  - `LinearString`: Linear memory for WASI I/O, FFI
  - `HostString`: Wraps JS/DOM strings directly
  - `LiteralString`: Backed by WASM data segment
  - `RopeString`: Efficient concatenation (future)
- Encoding design
  - WTF-8 vs WTF-16 (not UTF - allows unpaired surrogates for JS interop)
  - `--default-encoding` flag
  - Mixed encodings at runtime
  - Transcoding on concatenation
- View-based design (like Go)
  - O(1) `slice()` shares backing array
  - Memory retention tradeoff
  - `copy()` for ownership
- Unicode abstraction
  - Hide encoding from users
  - Iterate over code points, not bytes
  - `length` in code units vs `codePointCount()`
- `StringBuilder`: Efficient multi-string construction
- `StringReader`: Efficient parsing and scanning 🚧
- JS host interop
  - WTF-16 for zero-copy with JS
  - Unpaired surrogate preservation
- Performance characteristics
  - Virtual dispatch on String methods
  - Template method pattern for code sharing
  - Devirtualization when concrete type known

### 4.11 Type System (detailed)

- Nominal vs structural typing philosophy
- Soundness guarantees
- Type widening rules
- Variance

### 4.12 Boxing (detailed)

- When boxing occurs
- Performance implications
- Avoiding unnecessary boxing

### 4.13 Destructuring & Patterns (detailed)

- All pattern forms
- Pattern matching vs destructuring assignment
- `if let` and `while let` patterns

### 4.14 Records & Tuples (detailed)

- Structural typing details
- Unboxed tuples vs boxed tuples
- Performance characteristics

### 4.15 Classes (detailed)

- Two-phase construction
- Inheritance model
- Method resolution order
- Memory layout

### 4.16 Interfaces (detailed)

- Fat pointer representation
- Performance vs classes
- Design patterns

### 4.17 Mixins (detailed)

- Linearization
- Diamond problem resolution
- When to use mixins vs inheritance

### 4.18 Standard Library (detailed)

- `Array<T>` API
- `Map<K, V>` API
- Iteration protocol
- `Box<T>` usage
- `Error` class

### 4.19 Performance Guide

- Cost of abstractions
- Vtables and indirect calls
- Trampolines
- Fat pointers
- Boxing overhead
- WASM VM optimizations (ICs, etc.)
- Profiling Zena code

---

## 5. "Zena for X Developers" Guides

Migration guides for developers coming from other languages.

### 5.1 Zena for TypeScript Developers

- Syntax similarities and differences
- `let` means immutable (not mutable!)
- Sound type system (no `any` escape hatch)
- No implicit coercion
- Nominal classes vs structural TypeScript
- WASM compilation vs JS execution

### 5.2 Zena for Swift Developers

- Value types vs reference types
- Optional handling
- Protocol/interface comparison
- Extension comparison

### 5.3 Zena for Dart Developers

- Class and mixin comparison
- Sound null safety comparison
- Generic variance differences

### 5.4 Zena for Go Developers

- Interface comparison (structural vs nominal)
- Error handling differences
- No goroutines (WASM threading)

### 5.5 Zena for Rust Developers

- No borrow checker (GC instead)
- Match expression similarities
- Generic implementation comparison

---

## 6. WASI Integration

### 6.1 Overview

- What is WASI?
- `--target wasi` vs `--target host`

### 6.2 Using WASI APIs

- File system access
- Console I/O
- Environment variables

### 6.3 WIT Integration 🔮

- Importing WIT definitions
- Generating WIT from Zena
- Component model

### 6.4 Running Zena with wasmtime

- Command-line options
- Capability flags
- Examples

---

## 7. Standard Library Reference

API documentation for stdlib. (Could be auto-generated.)

- `Array<T>`
- `Map<K, V>`
- `Box<T>`
- `Error`
- `String` methods
- Iteration protocol

---

## Implementation Priority

### Phase 1: Early Contributor Documentation

1. **One-Page Language Reference** — Essential for anyone trying the language
2. **How Zena Translates to WASM** — For contributors understanding the compiler

### Phase 2: User Documentation

3. Philosophy & Goals page
4. Zena for TypeScript Developers (largest audience)
5. Expand detailed guide pages as needed

### Phase 3: Complete Documentation

6. Remaining "Zena for X" guides
7. Full standard library reference
8. WASI integration guide
9. Advanced performance guide

---

## Content Sources

Existing documentation to draw from:

- [docs/language-reference.md](../../docs/language-reference.md) — Main language reference
- [docs/design/](../../docs/design/) — Detailed design documents
  - [ai-first-language.md](../../docs/design/ai-first-language.md) — AI optimization philosophy
  - [generics.md](../../docs/design/generics.md) — Generic implementation details
  - [classes.md](../../docs/design/classes.md) — Class design
  - [interfaces.md](../../docs/design/interfaces.md) — Interface design
  - [strings.md](../../docs/design/strings.md) — String implementation
  - [wasi.md](../../docs/design/wasi.md) — WASI integration
  - Many more...
- [packages/website/src/tour-plan.md](tour-plan.md) — Previous tour outline

---

## Notes

- Mark features as "future work" or "not yet implemented" where appropriate
- Include runnable examples where possible (once playground exists)
- Keep code examples short and focused
- Cross-link between pages
- Use consistent terminology throughout
