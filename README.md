# The Zena Programming Language

Zena is a statically typed programming language designed from the ground up to compile to compact, high-performance [WebAssembly GC](https://github.com/WebAssembly/gc/blob/main/proposals/gc/Overview.md) binaries with a fast, self-hosted toolchain.

Zena takes TypeScript's syntax and ergonomics as a starting point, pairing them with a sound static type system and consistent semantics free from JavaScript's historical quirks. It integrates proven features from modern languages—Dart, Swift, Scala, Rust, and Kotlin—along with novel systems for resource ownership, asynchronous cancellation, and native WebAssembly Component Model support.

```zena
// Variables are immutable by default; primitive types are strict
let maxRetries: i32 = 3;
var attempts = 0;

// Sealed class hierarchies for algebraic data types
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}

// Pattern matching expressions with exhaustiveness checking
let area = (shape: Shape): f64 => match (shape) {
  case Circle {radius}: 3.14159 * radius * radius
  case Rect {width, height}: width * height
};

// Classes with Dart-style constructors and private fields
class Counter {
  #step: i32;
  var count: i32 = 0;

  new(this.#step);

  increment() {
    this.count += this.#step;
  }
}

// Pipelines for readable data flow
let formatted = "  hello world  "
  |> trim($)
  |> toUpperCase($);
```

> [!WARNING]
> Zena is under active development and is not ready for production use.
> Syntax, semantics, and standard libraries are changing rapidly, and breaking
> changes occur frequently.

## Key Features

### Familiar Syntax, Sound Semantics
Zena builds on TypeScript-like syntax while enforcing strict static guarantees:
- **Sound type system:** No `any` type, no unchecked casts, and no implicit type coercion.
- **Strict primitives & nullability:** Dedicated numeric types (`i32`, `i64`, `u32`, `u64`, `f32`, `f64`). References are non-nullable by default.
- **Immutability by default:** Variables (`let`) and class fields are immutable by default; `var` marks mutable state.
- **Expression-oriented control flow:** `if`, `match`, and `try` evaluate directly to values.

### Ideas from Modern Languages
- **Dart:** Constructors with initializer lists and `this.` parameter shorthand; class mixins for flexible code reuse.
- **Swift:** Immutability defaults, `var`/`let` distinction, compound assignment operators (no `++` or `--`).
- **Scala:** Sealed class hierarchies, case classes, and exhaustive pattern matching with destructuring.
- **Rust & Kotlin:** Algebraic data types, pipeline operator (`|>`), and structured control expressions.

### Language Innovations
- **Affine Resource & Ownership System:** Deterministic lifecycle management for non-GC resources (WASI file descriptors, Component Model handles, linear memory). `resource class`, `Own<T>`, and `Borrow<T>` enforce move semantics and stack-bound borrows at compile time without complex lifetime annotations.
- **First-Class Async Cancellation:** Asynchronous cancellation flows through a dedicated language channel. Dedicated `cancel` blocks in `try/catch/cancel/finally` handle interruption cleanly, while `shielded` blocks ensure critical cleanup runs to completion.
- **Native WIT & Component Model Integration (In Progress):** Direct compiler support for WebAssembly Interface Type (`.wit`) files and WASI interfaces without external code generators or intermediate bindgen tools.
- **Unboxed Value Types & Multi-Value Returns:** Functions can return multiple values as unboxed inline tuples on the stack with no heap allocation (used in standard APIs like `Map.get()`), expanding toward unboxed composite types and Struct-of-Arrays (SoA) layouts.

### WebAssembly GC Native
- **Direct mapping:** Primitives, references, records, tuples, and arrays compile directly to native Wasm GC types and instructions. Modules ship without an allocator or garbage collector.
- **Zero-boxing generics:** Generics are monomorphized to concrete Wasm types, avoiding runtime wrapper objects.
- **Compact binaries:** Aggressive dead-code elimination and optimization passes remove unused functions, classes, and types.

### Unified Toolchain
The `zena` CLI is a single tool that includes:
- **Self-hosted compiler:** Written in Zena and compiling to native Wasm with a ZIR (CFG/SSA) backend.
- **Integrated tools:** Test runner, code formatter, and language server (LSP).

## Status

Zena is in active development and experimental. The core language (classes, interfaces, mixins, generics, pattern matching, records, tuples, exceptions, SIMD, and async functions) is implemented in the self-hosted compiler. Work is ongoing on the ZIR optimization pipeline, async cancellation, the affine ownership system, and native WIT integration.

## Development with Generative AI

Zena is implemented primarily through generative AI paired with human architecture, engineering guidance, and code review. It serves as both an active language project targeting modern WebAssembly environments and an exploration of AI-assisted language engineering and toolchain development.

## Documentation

- [Language Reference](docs/language-reference.md) – Syntax and semantics specification
- [Quick Reference](packages/website/src/reference/quick-reference.md) – Comprehensive feature reference
- [Design Documents](docs/design/) – Architecture and feature design specifications
- [Online Playground](https://zena-lang.org/playground/) – Interactive browser-based compiler and editor

## Getting Started

### Prerequisites
- Node.js v25+
- npm
- [wasmtime](https://wasmtime.dev/) (for running standalone or WASI binaries)

### Building from Source

```bash
git clone https://github.com/elematic/zena.git
cd zena
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
