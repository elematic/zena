---
title: 'What is Zena?'
description: 'A statically typed, garbage-collected language designed for WebAssembly GC, combining a familiar syntax with modern language design.'
---

Zena is an ahead-of-time compiled, statically typed, garbage-collected,
multi-paradigm programming language that targets **WebAssembly GC** exclusively.

Zena starts from a familiar TypeScript-like base, with a similar syntax for
functions, objects, classes, and types. But Zena is not tethered to the
TypeScript or JavaScript's compatibility, so it removes the dynamism, implicit
coercions, and loose corners that make JavaScript difficult to compile and
reason about.

On top of that foundation, Zena pulls together ideas from across modern
programming languages, like Dart, Rust, Swift, Scala, Kotlin, and Go, and
designs them in concert to make a consistent, cohesive whole. It is crafted with
care and intention: a language you _want_ to write because it feels ergonomic,
safe, and pleasant to use, while compiling to tiny, fast Wasm modules.

## What it looks like

```zena
import {sqrt} from 'zena:math';

// `let` is immutable; `var` is variable. Both block-scoped.
let greeting = 'Hello';
var count = 0;

// Top-level functions use the `function` keyword
function writePoint(p: Point) {
  console.log(`(${p.x}, ${p.y})`);
}

// Arrow functions are closures
let add = (a: i32, b: i32) => a + b;

class Point {
  // Class fields are immutable by default
  x: f64;
  y: f64;

  // Constructors must initialize all non-null fields
  new(this.x, this.y);

  magnitude(): f64 {
    return sqrt(this.x * this.x + this.y * this.y);
  }
}

// Sealed hierarchies plus `match` give you exhaustively checked ADTs.
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}

let area = (shape: Shape): f64 => match (shape) {
  case Circle {radius}: 3.14159 * radius * radius
  case Rect {width, height}: width * height
};
```

## Built for WebAssembly GC

WebAssembly GC brings native garbage collection to Wasm, alongside first-class
struct, array, and reference types. Zena is designed specifically around these
primitives:

- **Direct type mapping**: Primitives are real Wasm value types (`i32`, `f64`),
  classes compile to Wasm GC structs, and fixed arrays become Wasm GC arrays.
- **Zero runtime overhead**: There is no garbage collector, memory allocator,
  or runtime engine bundled into your binary. A compiled module contains your
  code and a handful of standard library helpers.
- **Monomorphized generics**: Generics are specialized per type, so `Array<i32>`
  stores unboxed `i32` values with no wrapper objects or runtime casts.

Because Zena does not have to support legacy runtimes, its semantics align
directly with what WebAssembly executes best. → [Why Zena?](/guide/why-zena/#the-wasm-gc-gap)

## Modern features

Zena departs from TypeScript whenever doing so yields a better, safer, or more
enjoyable language.

### Immutability by default

Zena records, and tuples are immutable, and variables and class fields are
immutable by default.

### Sound, trustworthy types

Zena's type system is sound: types never lie at runtime. References are
non-nullable by default, downcasts are checked, and constructors use Dart-style
initialization so a `this` reference cannot escape before all fields are
initialized. Flow-based type narrowing works alongside these guarantees so the
strictness feels natural rather than pedantic.

### Pattern matching and destructuring

Pattern matching is pervasive in Zena. The `match` expression provides
exhaustive matching over values, sealed hierarchies, records, and tuples,
complete with pattern guards. Pattern syntax also powers `if let`, `while let`,
and destructuring in variable declarations.

### Sealed classes and case classes

Zena provides algebraic data types through sealed class hierarchies and concise
`case class` declarations. Unlike simple tagged enums, sealed cases are full
classes: they can define methods, implement interfaces, and apply mixins, while
retaining exhaustiveness checking across all `match` expressions.

### Expression-oriented control flow

In Zena, control flow constructs are expressions. `if`, `match`, `try`/`catch`,
`throw`, `return`, `continue`, and `break` all produce values, allowing you to
write concise, declarative code without temporary mutable variables.

### Unboxed multi-value returns and value types

Inline tuples compile directly to WebAssembly multi-value returns with zero heap
allocation. This makes multi-value return patterns efficient enough for core
APIs: `Map.get()` returns `(found, value)` and `Iterator.next()` returns
`(hasValue, value)` in a single call without allocating wrapper objects.
First-class value records build on this to bring the same zero-allocation
benefits to structured data.

### Structured async and cancellation

Async functions return `Future<T>` and suspend explicitly at `await` points.
Zena integrates ambient cancellation scopes into the runtime: cancellation
travels through a dedicated channel, triggering cleanup in `cancel` and `finally`
blocks while `shielded` blocks protect critical unwind operations. All async
functions are cancellable by default, guarding against orphaned background work.

### Resource management and ownership

Zena pairs its garbage-collected model with explicit and automatic resource
management for non-GC resources like file descriptors, linear memory buffers,
and WIT component handles. Deterministic cleanup is supported via `using`
declarations, while affine `Own<T>` and `Borrow<T>` types provide compile-time
ownership tracking without complex lifetime annotations.

### Ergonomic classes and mixins

Classes avoid constructor boilerplate with `this.` parameters and initializer
lists. Linearizable mixins (`class Dog with Friendly`) allow sharing
implementation across hierarchies cleanly without multiple-inheritance
ambiguities. Symbol-keyed members provide flexible, modular visibility beyond
rigid public/private keywords.

### Pipelines and functional tools

The pipeline operator (`|>`) with placeholder syntax (`$`) enables readable
left-to-right data transformations. Combined with lightweight arrow functions,
lexical closures, and collection operations (`map`, `filter`, `fold`),
functional patterns fit naturally into everyday code.

### Contracts and units of measure <span class="badge info">Planned</span>

Planned extensions include static dimensional analysis (units of measure like
`Meters` or `Seconds` checked at compile time with zero runtime overhead) and
first-class contract annotations (`requires`, `ensures`) to catch domain bugs
before code runs.

## Where the project stands

Zena is under active development and is **not yet ready for production use**.
The compiler is self-hosted, written in Zena, and passes its portable test
suites. Work is focused on the optimizing SSA IR backend (ZIR), component model
integration, and language tooling.

→ Read the [Status and Roadmap](/development/roadmap/) for details on what is
implemented today and what is coming next.

## Next

- [Language Overview](/guide/overview/) — a whirlwind tour of syntax and features
- [Why Zena?](/guide/why-zena/) — the motivation, target use cases, and design philosophy
- [Getting Started](/guide/getting-started/) — install the toolchain and run your first program
