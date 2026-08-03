---
title: 'What is Zena?'
description: 'Zena is a statically typed language designed specifically to compile to WebAssembly GC, with a familiar syntax and a sound type system.'
---

Zena is a statically typed, garbage-collected programming language that compiles
to **WebAssembly GC**. Its entire design — syntax, semantics, type system,
standard library, and compiler implementation — was chosen to enable the best
Wasm GC output possible.

Zena starts from a TypeScript-like base and removes the dynamism and implicit
coercions that make JavaScript hard to compile and to reason about. It makes the
type system sound, and adds modern features from languages like Rust, Swift, and
Dart. All of it is tailored to Wasm GC so that Zena compiles to modules small
enough to ship on a web page, and is fast enough to write a compiler in — its
own compiler is written in Zena.

## Built for Wasm GC

Wasm GC gives a module the host's garbage collector and native struct, array,
and reference types. Zena assumes all of it, so every design decision has an
answer to "what does this compile to?":

- Primitives are real Wasm value types — `i32` is an `i32`, not a boxed number.
- Classes become Wasm GC structs; arrays become Wasm GC arrays.
- Generics are monomorphized, so `Array<i32>` holds unboxed `i32`s.
- The type system rules out constructions that would force boxing or runtime
  type tags.

Nothing is shipped in your module except your code and a handful of string
helpers. There is no allocator, collector, or runtime to pay for.

Languages that reached Wasm from somewhere else cannot do this without
trade-offs. → [Why Zena?](/guide/why-zena/#the-wasm-gc-gap)

## How it compares

| Language           | Wasm target    | Runtime shipped | Memory     | Sound types    | Null safety    |
| ------------------ | -------------- | --------------- | ---------- | -------------- | -------------- |
| Zena               | Wasm GC (only) | none            | Wasm GC    | yes            | non-nullable   |
| Dart               | Wasm GC        | runtime         | Wasm GC    | yes            | sound          |
| Kotlin             | Wasm GC        | runtime         | Wasm GC    | mostly         | nullable types |
| Scala              | Wasm GC        | runtime         | Wasm GC    | yes            | `Option`       |
| Rust               | linear memory  | allocator       | ownership  | yes            | no nulls       |
| Go                 | linear memory  | GC + scheduler  | bundled GC | yes            | zero values    |
| Swift              | linear memory  | runtime         | ARC        | yes            | optionals      |
| AssemblyScript     | linear memory  | GC + allocator  | bundled GC | escape hatches | non-nullable   |
| TypeScript, hosted | linear memory  | a JS engine     | bundled GC | no, by design  | opt-in         |
| TypeScript, AOT    | linear memory  | small runtime   | bundled    | no, by design  | opt-in         |
| Python             | linear memory  | interpreter     | bundled GC | dynamic        | `None`         |

**No JavaScript or TypeScript toolchain reaches Wasm GC today.** There are two
approaches and neither uses it. The established one compiles an entire JS engine
to linear-memory Wasm and runs your code inside it — that's Javy, `componentize-js`,
and StarlingMonkey, and it means shipping the engine and its garbage collector
with every module. The newer one compiles JS or TypeScript ahead of time —
[Porffor](https://porffor.dev/) is the furthest along, and it routes through C
to reach native. Those compilers could adopt Wasm GC eventually; none has, and
none is proven yet. [AssemblyScript](https://www.assemblyscript.org/status.html)
is explicit about it: it implements its own garbage collector in linear memory
and is waiting on the GC and function-references proposals.

Dart, Kotlin, and Scala do use Wasm GC, through `dart2wasm`, Kotlin/Wasm, and
Scala.js respectively — but as an additional backend alongside their original
target, and each still ships a runtime. Zena has no other target to serve, which
is what the first two columns are really measuring.

If you know TypeScript, most Zena code will read correctly on the first pass.
The differences are deliberate corrections rather than novelty — see
[Zena for TypeScript developers](/guide/from/typescript/).

## What it looks like

```zena
import {sqrt} from 'zena:math';

// `let` binds immutably; `var` opts into mutation.
let greeting = 'Hello';
var count = 0;

// Functions are arrow functions. Types are inferred where they're obvious.
let add = (a: i32, b: i32) => a + b;

// Classes get Dart-style constructors and immutable fields by default.
class Point {
  x: f64;
  y: f64;
  new(this.x, this.y);

  magnitude(): f64 => sqrt(this.x * this.x + this.y * this.y);
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

## Where the project stands

Zena is under active development and is **not yet ready for production use**.
The bootstrap compiler and the self-hosted compiler are both complete; work is
currently focused on a new SSA-based optimizing backend.

It also has no users, which for now is an advantage rather than a gap: nothing
depends on the current design, so anything that turns out wrong can still be
changed outright. Expect the language to move, and expect breaking changes while
that remains true.

Documentation pages describe what is implemented today. Where a feature is
designed but not yet shipped, the page says so with a badge.

## Next

- [Why Zena?](/guide/why-zena/) — the case for a new language
- [Getting started](/guide/getting-started/) — install the toolchain
- [Your first program](/guide/first-program/) — write and run some code
