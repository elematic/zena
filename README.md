# The Zena Programming Language

Zena is a statically typed programming language designed from the ground up to compile to compact, high-performance [WebAssembly GC](https://github.com/WebAssembly/gc/blob/main/proposals/gc/Overview.md) binaries with a fast, integrated toolchain. It combines a familiar, TypeScript-like syntax with the best features of modern languages—Swift, Dart, Scala, Go, and Kotlin—and a sound, correctness-focused type system.

```typescript
let x = 42; // Immutable variable, inferred type
var y: String = "hello"; // mutable variable

interface Animal {
  sayHi(): String;
}

distinct type CatId = String; // Nominal type alias

class Cat implements Animal {
  #greeting = 'Hi'; // Private field
  name = 'Bob'; // Mutable public field
  let id: CatId; // Immutable field
  var(#mood) mood: 'aloof' | 'grumpy'; // Public field, private setter

  // Constructor with initializer list
  new(id: CatId) : id = id {}

  sayHi() {
    return `${this.greeting}, I'm ${this.name}`;
  }
}

// A function that uses pattern matching
export let getChildren = (n: Node) => match (n) {
  case {left, right}: [left, right] // array literal
  case {children}: children
  case _: []
}

// Pipelines
let formatTitle = (title: String) => title
  |> trim($)
  |> titleCase($)
  |> truncate($, 80);

```

> [!WARNING]
> Zena is so new that syntax might change a lot! In particular, we're unsure
> about `new()` for constructors, `let` and `var` as class field modifiers...

## Why Zena?

### The Wasm GC Sweet Spot

While languages like Rust excel at targeting Wasm linear memory, Zena is designed specifically for WebAssembly's managed object model (Wasm GC). This eliminates the need to ship an allocator or garbage collector with Zena modules. This direct mapping shapes Zena's design:

- **Wasm-Only Primitives:** Primitive types map directly to Wasm primitives for zero conversion overhead.
- **Native Arrays:** Zena arrays compile directly to native Wasm GC arrays without wrappers or boxing.
- **Zero-boxing generics** are monomorphized directly to concrete Wasm types.
- **Structural records and tuples** compile directly to native Wasm GC structs and multi-value stack returns.
- **Wasm GC exceptions** drive zero-overhead error handling.
- **String encoding transparency:** Strings hide their encoding, working transparently with host-specific string encodings (vital for diverse Wasm hosts).
- **Nominal enums** map to efficient wrapper types.

### Predictable & Consistent Semantics

Zena provides simple, expected behavior with no magical surprises or implicit coercions:

- **Consistent scoping:** Variable declarations are block-scoped and immutable (`let`) by default, with explicit mutable `var`.
- **Strict primitive types:** Distinct primitive numeric types (`i32`, `i64`, `u32`, `u64`, `f32`, `f64`) rather than a single runtime representation.
- **No implicit type coercions:** Preventing accidental conversions at compile time.
- **Clear separation:** Clear distinction between structural records (for plain data) and classes (for nominal types with behavior).
- **Safer semantics:** Clean, consistent `for-in` loop iteration over iterables and iterators.

### Prioritizing Correctness

Zena places a strong emphasis on reliability and type safety:

- **Sound type system:** Statically checked with no escape hatches, ensuring Zena programs cannot have runtime type errors.
- **Safety by default:** Immutability by default, exhaustiveness checking for pattern matching, checked casts, and distinct types.
- **Contracts:** Future support for pre/post-condition contracts and numeric unit types to verify physical quantities at compile time.

### Modern Ergonomics

Developer productivity features inspired by Swift, Dart, Scala, Go, and Kotlin:

- **Algebraic Data Types:** Natively supported via sealed class hierarchies, union types, and records.
- **Expression-oriented:** Control flow constructs like `if`, `try`, and `throw` are expressions that evaluate to values.
- **Pattern Matching:** Exhaustive `match` expressions with destructuring.
- **Pipelines:** The `|>` pipeline operator for clean, readable function chaining.
- **Rich object model:** Dart-style constructors, mixins, and extension classes.
- **Tiny & Fast Binaries:** Aggressive dead-code elimination removes unused functions, classes, and types, producing minimal binaries (as little as 37 bytes for small programs).

### Integrated Toolchain

A unified development experience built directly into a single CLI tool:

- **All-in-one:** Includes the compiler, test runner, LSP language server, formatter, and future linting/MCP tools.
- **Self-contained:** The entire toolchain is written in Zena itself and compiled to run natively on Wasm.

### WASI & WIT Integration (In Progress)

First-class support for the WebAssembly Component Model:

- **Direct import/export:** Import and export WASI components directly without intermediate "bindgen" wrapper tools.
- **Native WIT parsing:** Zena's compiler understands WebAssembly Interface Type (`.wit`) files natively to generate type-safe bindings.

### Rich Standard Library (In Progress)

A Python-inspired "batteries included" standard library built on top of WASI:

- **Core modules:** Includes built-in support for unit testing, command-line arguments parsing, file system access, HTTP networking, regular expressions, and JSON parsing.

## Status

Zena is not ready for use!

Zena is very early in it' development and may things are changing, including
syntax, and defaults for immutability, etc. Many features are partially
implemented, and there are likely lots of hidden bugs in the features that are
implemented.

Currently, features are being added rapidly, the standard library is being built
out, and WASI P2 support is being added, with an immediate goal of porting the
compiler to Zena and self-hosting.

## Feature Highlights

### Classes, Interfaces, and Mixins

```typescript
interface Printable {
  toString(): String;
}

mixin Named {
  name: String;
}

class User with Named implements Printable {
  age: i32;

  new(name: String, age: i32) {
    this.name = name;
    this.age = age;
  }

  toString(): String {
    return `${this.name} (${this.age})`;
  }
}
```

Classes support inheritance, abstract members, `final` sealing, private `#`
fields, accessors, operator overloading, and generic type parameters. Interfaces
use fat pointers with vtables for efficient dynamic dispatch.

### Generics

Generics are fully monomorphized. `Array<i32>` stores raw integers with zero
boxing overhead:

```typescript
let identity = <T>(x: T): T => x;

identity(42); // monomorphized for i32
identity('hello'); // monomorphized for String
```

Type parameters support constraints (`T extends Comparable`) and defaults
(`T = i32`). F-bounded polymorphism (`T extends Comparable<T>`) is coming soon.

### Operator overloading

Zena lets classes overload `==`, `[]`, `[]=`, `+`, with more comining soon.

Operator overloading should help make Zena ergonomic for scientific computing
and working with collections. Since final class members are resolved staticlly,
operator overloading doesn't cause any performance impact for array indexing on
built-in arrays.

### Records and Tuples

Zena supports immutable records and tuples. Records are collections of named
values. Tuples are a fixed list of values.

```typescript
let point = {x: 1.0, y: 2.0};
let items = (1, 'two', 3);
```

### Arrays

The `[...]` literal creates a `FixedArray<T>` — a fixed-size WASM GC array with
zero overhead. For growable arrays, use `Array.from()` or `new Array<T>()`.
A literal syntax for growable arrays is planned.

```typescript
let nums = [1, 2, 3]; // FixedArray<i32>
let grow = Array.from([1, 2, 3]); // Array<i32> (growable)
```

### Type definitions

Zena has a growing set of type expressions including primitives, literals,
records, tuples, functions, and unions.

```typescript
type Pet = Cat | Dog;
```

Distinct types create nominal or "branded" types over other types.

```typescript
distinct type UserId = i32;
distinct type PostId = i32;

let x: UserId = 1 as PostId;  // ❌ Error: type mismatch
```

Type type system has restrictions to help keep types sound and the WASM output
small and fast.

For instance, union members must be distinguisable and able to be stored in one
WASM value type. You can't mix primitives and references because there's no
WASM type that allows that. You must box primitives instead (`T?` is shorthand
for `T | null`):

```typescript
type NullableId = i32?; // ❌ Error
type Nullable<T> = T?; // ❌ Error: T could be a primitive

type NullableId = Box<i32>?; // ✅ OK
type Nullable<T extends anyref> = T?; // ✅ OK

type NullableId = Option<i32>; // ✅ Also OK
```

### Enums

Untagged enums map to i32 or String as distinct types. Sealed classes with case classes serve the role of tagged enums (enums with associated data).

```typescript
enum Direction {
  Up = 'UP',
  Down = 'DOWN',
  Left = 'LEFT',
  Right = 'RIGHT',
}
```

### Expression-Oriented Control Flow

`if` and `match` are expressions that return values:

```typescript
let abs = if (x >= 0) x else -x;

let label = match (level) {
  case 1: "low"
  case 2: "medium"
  case _: "high"
};
```

### Pattern Matching

Pattern matching works with the `match()` expression, which checks for
exhaustiveness:

```typescript
class Circle { radius: f32; new(radius: f32) { this.radius = radius; } }
class Rect { w: f32; h: f32; new(w: f32, h: f32) { this.w = w; this.h = h; } }

let area = (shape: Circle | Rect): f32 => {
  match (shape) {
    case Circle {radius}: 3.14159 * radius * radius
    case Rect {w, h}: w * h
  }
};
```

And while/let and if/let statements:

```typescript
if ((let(value, true) = map.get(key))) {
  // key was found in the map, value is valid
}

while ((let(value, true) = iterator.next())) {
  // The iterator had another value
}
```

Patterns support literals, records, classes, guards, `as` bindings, and logical
`|` / `&` combinators. Exhaustiveness is checked at compile time.

### Multi-Value Returns

Functions can return multiple values as inline tuples that compile to WASM's
multi-value return, with no heap allocation or wrapper objects:

```typescript
let divmod = (a: i32, b: i32): (i32, i32) => {
  return (a / b, a % b);
};

let (quot, rem) = divmod(17, 5); // quot = 3, rem = 2
```

This powers zero-allocation iterators:

```typescript
interface Iterator<T> {
  next(): (T, true) | (never, false);
}
```

### Destructuring

Destructuring is a form of pattern matching that always matches. If the match
isn't guarenteed, it's a compile error.

You can destructure objects, records, tuples, and inline tuples (mult-value
returns):

```typescript
let {x, y} = point; // Object desctructuring
let (_, _, z) = vec; // Tuples
let (value, found) = map.get(key); // Inline tuples - no heap allocation
let {x, y, z = 0} = point; // Defaults: point can be 2D or 3D
let {r as red, b as blue} = color; // Renaming
```

### Pipeline Operator

The `|>` operator turns nested calls into a readable left-to-right flow. The `$`
placeholder marks where the piped value goes:

```typescript
let result = data |> parse($) |> transform($) |> validate($);

// Equivalent to: validate(transform(parse(data)))
```

## Roadmap & Status

Zena is currently in active development. Most of the core language features (classes, interfaces, generics, pattern matching, records and tuples, exceptions, and algebraic data types) are fully implemented and optimized (with dead-code elimination and zero-boxing generics).

### Current Focus: Self-Hosted Compiler

The self-hosted compiler (`packages/zena-compiler`) is written in Zena itself and already passes all syntax, language, and execution tests. We are currently building a new IR-based backend to unlock advanced optimizations. Once development moves completely to the self-hosted compiler, the TypeScript bootstrap compiler will be retired.

### Upcoming Platform Features

- **WASI Component Model & WIT**: Direct integration with the WebAssembly Component Model, importing `.wit` files natively.
- **Async Functions & Cooperative Multithreading**: Native support for asynchronous execution, targeting upcoming WASM P3 features with cooperative multithreading.
- **Tooling & DX**: A package manager, online playground, and enhanced VS Code integration.

### Post-Bootstrap Roadmap

After retiring the bootstrap compiler, we plan to implement headline features that distinguish Zena from TypeScript:

- **Numeric Unit Types**: Statically verified physical units and units of measure (e.g. preventing adding meters to feet at compile time).
- **SIMD**: Native WebAssembly vector instruction support for high-performance computing.
- **Decorators and Macros**: Metaprogramming capabilities for compile-time code generation and extension.
- **Contracts**: `requires` and `ensures` pre/post-conditions, enabling runtime assertion checks and future static verification using SMT solvers.

## WASM & WASI

Zena targets WASM-GC natively, but also supports the broader WASM ecosystem:

```bash
# Compile for a JS host environment
zena build main.zena -o main.wasm --target host

# Compile for WASI
zena build main.zena -o main.wasm --target wasi

# Run with wasmtime
wasmtime run -W gc,function-references,exceptions --invoke main main.wasm
```

**Linear memory.** The `zena:memory` standard library module provides tools for
working with linear memory when you need direct byte-level access, such as for
binary formats or interop with non-GC WASM modules.

**Component Model.** We're working toward letting Zena modules import WIT files
directly, with no code generation step, to emit WASI components and WIT
interfaces with no additional tools required.

**Looking ahead.** Today, WASI components require lowering GC types to linear
memory. We're looking forward to future WASI proposals that support GC types
natively, which would let Zena components avoid the lowering overhead entirely.

## Correctness

Zena is designed to reduce the chance of errors, whether the code is written by
humans or generated by AI.

**Sound type system.** There should be no ways for a variable or parameter to lie
about its type. If a variable has type `String`, it really is a `String` at runtime. There are no known unsound escape hatches. Soundness is helped by a few additional features:

- **Reified generics** `Array<i32>` and `Array<f64>` are distinct types, even at
  runtime, so runtime type checks like `x is Array<i32>` work.
- **Checked casts.** All `as` casts are either eliminted at compile time or
  verified at runtime.
- **Class initializer lists.** Constructors use initializer lists that guarantee
  every immutable and non-nullable field is set before the object becomes visible. It's impossible to leak a partially initialized object.

Some types, like `i32`, `u32`, and `boolean`, or type aliases on the same underlying type, have the same underlying representation and can be cast between each other, but this should not affect the overall soundness of the program's types.

**Future correctness projects** Zena is going to continue to add more features that
aid in ensuring correctness.

- **Distinct types and units of measure.** Distinct types already let you create
  type-safe wrappers at zero cost, so `UserId` and `PostId` can't be accidentally
  swapped even though both are `i32` underneath. Planned numeric units of measure
  will extend this further with smoother syntax and unit analysis, catching
  mistakes like adding meters to feet at compile time.
- **Purity.** The `@pure` annotation marks functions as side-effect-free. Today
  this is trusted, not verified, but it documents intent and enables future
  optimizations. In the future we will try to verify purity annotations or
  automaticaly infer them.
- **Contracts and verification.** We plan to add `requires` and `ensures`
  contracts that specify what functions expect and guarantee. Runtime contracts
  catch violations early. Static verification (via SMT solvers) can prove
  contracts hold for all inputs. Combined with AI-generated code, this creates a
  powerful workflow: AI writes the implementation, the verifier proves it matches
  the spec.

## Zena and Generative AI

Zena is implemented primarily with the help of generative AI, and would not
exist without it. Zena started as a casual experiment: when the latest AI
modules showed huge improvements on working with complex codebases, we asked
Gemini to create a new programming language from scratch, and it did! The code
that we had the experience to review properly looked good, and so we kept going
and asking for changes and new features, and Zena is now growing into something
much more substantial.

You might call Zena a vibe-coded language, but the process has been less "vive"
and more "mentoring". There have been thousands of prompts over hundreds of
changes. Not all of the code was closely reviewed, but a lot of it was. Design
"discussions" with agents have helped shaped the language and compiler, weighed
the tradeoffs Zena is trying to make, and sometimes invovled push-back from both
human and agent.

Zena is still an experiment, just a more serious one now. Some of the questions
we are trying to answer with Zena include:

- Can coding agents allow one person or a very small team to produce a full,
  production-quality programming language with all the tooling and ecosystem
  pieces that are expected of modern languages?
- Can a new language break through the LLM training-set barrier? Many people
  worry that kickstarting a new language is impossible now, as popular
  languages that are in LLM training sets have an insurmountable advantage. On
  the other hand, LLM's universal translator abilities might make it matter less
  what language they're generating. Zena is attempting to be familiar enough to
  easily teach an LLM via context how to generate it.
- Can a project move from vibe-coding standards to proper engineering practices
  and still maintain the massive accelleration that coding agents give?
- Can a programming language help improve generative coding workflows and
  outcomes?

## Documentation

- [Language Reference](docs/language-reference.md): Detailed syntax and
  semantics
- [Quick Reference](packages/website/src/docs/quick-reference.md):
  Comprehensive feature guide
- [Design Documents](docs/design/): Architecture and feature design notes

## Getting Started

Zena is not yet released. To build from source:

```bash
git clone https://github.com/elematic/zena.git
cd zena
npm install
npm run build
npm test
```

### Prerequisites

- Node.js v25+
- npm
- [wasmtime](https://wasmtime.dev/) (for running WASI programs)

## License

[MIT](LICENSE)
