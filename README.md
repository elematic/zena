# The Zena Programming Language

Zena is a statically typed programming language that compiles to
[WebAssembly GC](https://github.com/nicolo-ribaudo/tc39-proposal-wasm-gc-js-interop).
It combines a familiar, TypeScript-like syntax with a sound type system,
zero- and low-cost abstractions, and modern language features, all designed for
ahead-of-time compilation to compact, high-performance WASM binaries.

```typescript
let x = 42; // Immutable variable, inferred type
var y: String = "hello"; // mutable variable

interface Animal {
  sayHi(): String;
}

distinct type CatId = string; // Nominal type alias

class Cat implements Animal {
  #greeting = 'Hi'; // Private field
  name = 'Bob'; // Mutable public field
  let id: CatId; // Immutable field
  var(#mood) mood: 'aloof' | 'grumpy'; // Public field, private setter

  // Constructor with initializer list
  #new(id: CatId) : id = id {}

  sayHi() {
    return `${this.greeting}, I'm ${this.name}`;
  }
}

// A function that uses pattern matching
export let getChildren = (n: Node) => match (n) {
  case {left, right}: #[left, right] // array literal
  case {children}: children
  case _: #[]
}

// Pipelines
let formatTitle = (title: String) => title
  |> trim($)
  |> titleCase($)
  |> truncate($, 80);

```

> [!WARNING]
> Zena is so new that syntax might change a lot! In particular, we're unsure
> about `#new()` for constructors, `#[...]` for mutable arrays vs `[...]` for
> tuples, and `let` and `var` as class field modifiers...

## Why Zena?

There are lots of languages that can target WASM, but most treat it as a
secondary backend. Zena is built **WASM-first**: every language feature maps
directly and efficiently as possible to WASM GC features.

- **Familiar syntax.** If you know TypeScript, you can read Zena. The type
  annotations, arrow functions, classes, and generics all look the way you'd
  expect.
- **Modern features.** Pattern matching with exhaustiveness checking, pipelines,
  multi-value returns, enums, distinct types, expression-oriented control
  flow, and more.
- **Sound type system.** Types are checked at compile time with no escape
  hatches. If it compiles, it won't throw a type error at runtime (except for
  possibly checked downcasts).
- **Zero- and low-cost abstractions.** Primitives and operators map directly to
  WASM. FixedArray is just a WASM Array, and indexing is exactly WASM's
  `array.get`/`array.set`. Generics are monomorphized (no boxing), multi-value
  returns go on the WASM stack (no allocation), and unused code is aggressively
  tree-shaken out of the binary. Classes and interfaces use vtables only when
  dynamic dispatch is needed.
- **Immutability-friendly.** `let` bindings, records, and tuples are immutable.
  Use `var` to opt in to mutability when you need it.
- **Tiny binaries.** Dead code elimination removes unused functions, classes,
  and even WASM types. Minimal programs compile to as little as 37 bytes.

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

  #new(name: String, age: i32) {
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
WASM type that allows that. You must box primitives instead:

```typescript
type NullableId = i32 | null; // ❌ Error
type Nullable<T> = T | null; // ❌ Error: T could be a primitive

type NullableId = Box<i32> | null; // ✅ OK
type Nullable<T extends anyref> = T | null; // ✅ OK

type NullableId = Option<i32>; // ✅ Also OK
```

### Enums

Untagged enums map to i32 or String as distinct types. Tagged enums are planned.

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

```typescript
class Circle { radius: f32; #new(radius: f32) { this.radius = radius; } }
class Rect { w: f32; h: f32; #new(w: f32, h: f32) { this.w = w; this.h = h; } }

let area = (shape: Circle | Rect): f32 => {
  match (shape) {
    case Circle {radius}: 3.14159 * radius * radius
    case Rect {w, h}: w * h
  }
};
```

Patterns support literals, records, classes, guards, `as` bindings, and logical
`|` / `&` combinators. Exhaustiveness is checked at compile time.

### Multi-Value Returns

Functions can return multiple values as unboxed tuples that compile to WASM's
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

### Pipeline Operator

The `|>` operator turns nested calls into a readable left-to-right flow. The `$`
placeholder marks where the piped value goes:

```typescript
let result = data |> parse($) |> transform($) |> validate($);

// Equivalent to: validate(transform(parse(data)))
```

## Feature Status

### Language

- [x] `let` / `var` bindings (immutable / mutable)
- [x] Primitive types: `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `boolean`
- [x] Strings (UTF-8, built-in class)
- [x] Arrow functions, closures, first-class functions
- [x] Classes, inheritance, abstract classes, `final` modifier
- [x] Private `#` fields, accessors (getters/setters)
- [x] Interfaces (nominal typing, fat-pointer vtables)
- [x] Mixins with composition and constraints
- [x] Generics with constraints, defaults, and monomorphization
- [x] Union types with control-flow narrowing (`is`, null checks)
- [x] Pattern matching (literals, records, classes, guards, exhaustiveness)
- [x] Multi-value returns and unboxed tuples
- [x] Pipeline operator (`|>` with `$` placeholder)
- [x] Enums (integer-backed and string-backed, nominal)
- [x] Distinct types (zero-cost newtypes)
- [x] Type aliases and function types
- [x] Records and tuples (structural types)
- [x] For loops, for-in loops, while loops
- [x] Iterators and `Sequence` protocol
- [x] Exceptions (`throw` / `try` / `catch`)
- [x] `never` type
- [x] Mutable arrays and array literals (`#[...]`)
- [x] Index operator overloading (`[]`, `[]=`)
- [x] Operator overloading (`==`, custom operators)
- [x] Tagged template literals
- [x] Modules, imports, and exports
- [x] Boolean literal types (`true` / `false` as types)
- [x] Let-pattern conditions (`if let`, `while let`)
- [x] Regexes
- [x] `any` type with auto-boxing
- [x] Contextual typing for closures
- [ ] Block expressions
- [ ] Map literals (`#{...}`)
- [ ] Extension methods
- [ ] SIMD
- [ ] Async functions
- [ ] Intersection types
- [ ] Tagged enums (enums with associated data)
- [ ] Decorators and macros
- [ ] Numeric unit types
- [ ] Context parameters
- [ ] Pre and post conditions

### Tooling

- [x] Compiler (TypeScript)
- [x] CLI (`zena build`)
- [x] Dead code elimination (functions, classes, methods, WASM types)
- [x] WASI target support
- [x] VS Code extension (syntax highlighting)
- [x] Website and documentation
- [ ] WASI P2 support
- [ ] Import .wit files
- [ ] Self-hosted compiler (in Zena)
- [ ] Online playground
- [ ] Package manager
- [ ] WIT/Component Model support

### Standard Library

- [x] `String`, `StringBuilder`
- [x] `Array<T>`, `FixedArray<T>`, `ImmutableArray<T>`
- [x] `Map<K, V>`, `Box<T>`
- [x] `Option<T>` (`Some` / `None`)
- [x] `Error`, `IndexOutOfBoundsError`
- [x] `ByteBuffer`, `ByteArray`
- [x] Ranges (`BoundedRange`, `FromRange`, `ToRange`, `FullRange`)
- [x] `console.log`
- [x] File I/O (WASI)
- [x] Math functions
- [ ] Extended math: trig, random, etc.
- [ ] `Set<T>`
- [ ] `DataView` for binary data
- [ ] Built-in WASI P2 interfaces

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
git clone https://github.com/nicolo-ribaudo/zena.git
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
