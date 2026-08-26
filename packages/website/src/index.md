---
layout: home.njk
title: Home
---

<!--
  The hero heading breaks exactly where this markup breaks: `.name` and `.text`
  are `white-space: pre-wrap`, so the newlines below are the ones you see
  rendered.

  Keep each block free of blank lines — markdown ends an HTML block at the first
  blank line, and everything after it would be parsed as markdown.
-->
<div class="hero">
  <div class="container">
    <div class="main">
      <div class="hero-warning-banner">
        <span class="badge danger">Warning</span>
        <span>Zena is under active development, changing rapidly, and not ready for use.</span>
        <a href="#project-status">See Project Status &rarr;</a>
      </div>
      <h1 class="heading">
        <span class="name clip">Zena</span>
        <span class="text">A fast, familiar, modern language
for WebAssembly GC</span>
      </h1>
      <p class="tagline">Syntax inspired by TypeScript. Modern features from Rust, Swift, Dart, and Kotlin. Designed from the ground up for ergonomics, safety, short compile times, and small binaries.</p>
      <div class="actions">
        <div class="action">
          <a class="button medium brand" href="/guide/getting-started/">Get started</a>
        </div>
        <div class="action">
          <a class="button medium alt" href="/guide/why-zena/">Why Zena?</a>
        </div>
        <div class="action">
          <a class="button medium alt" href="https://github.com/elematic/zena" target="_blank" rel="noreferrer">View on GitHub</a>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- `grid-3` on each item gives three across; `grid-2` and `grid-4` also exist. -->
<div class="features">
  <div class="container">
    <div class="items">
      <div class="item grid-3">
        <a class="feature link" href="/guide/web-assembly/">
          <article class="box">
            <div class="header">
              <div class="icon">🎯</div>
              <h2 class="title">WebAssembly GC native</h2>
            </div>
            <p class="details">Primitives, references, records, tuples, and arrays map directly Wasm GC types. Operators and function calls directly to Wasm instructions. No allocator, garbage collector, or language runtime shipped in your module.</p>
            <div class="link-text">
              <p class="link-text-value">WebAssembly <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/performance/">
          <article class="box">
            <div class="header">
              <div class="icon">⚡</div>
              <h2 class="title">Tiny, fast binaries</h2>
            </div>
            <p class="details">The combination of direct Wasm mapping and aggressive optimizations produces compact modules. Monomorphization eliminates boxing for generic code.</p>
            <p class="details">And when speed and size are in tension, compiler options let you control the balance.</p>
            <div class="link-text">
              <p class="link-text-value">Performance <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/overview/">
          <article class="box">
            <div class="header">
              <div class="icon">🧘</div>
              <h2 class="title">Familiar & predictable</h2>
            </div>
            <p class="details">TypeScript-like syntax with the best ideas from Rust, Swift, Dart, and Kotlin, combined into a cohesive whole. Real numeric types, no implicit coercion, and a stable program structure means fewer surprises.</p>
            <div class="link-text">
              <p class="link-text-value">Language overview <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/correctness/">
          <article class="box">
            <div class="header">
              <div class="icon">🔐</div>
              <h2 class="title">Safe and Sound</h2>
            </div>
            <p class="details">Correctness is anchored by a sound type system, non-nullable types, guaranteed class initialization, exhaustive pattern matching, and checked casts.</p>
            <div class="link-text">
              <p class="link-text-value">Correctness <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/overview/#borrowed-from-other-languages">
          <article class="box">
            <div class="header">
              <div class="icon">🦾</div>
              <h2 class="title">Modern ergonomics</h2>
            </div>
            <p class="details">Expression-oriented control flow, pattern matching, algebraic data types, multi-value returns, pipelines, automatic resource management, and more.</p>
            <div class="link-text">
              <p class="link-text-value">Inspiration <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/reference/cli/">
          <article class="box">
            <div class="header">
              <div class="icon">🛠️</div>
              <h2 class="title">Unified toolchain</h2>
            </div>
            <p class="details">Compiler, test runner, formatter, and language server in a single CLI, all written in Zena and running natively on Wasm.</p>
            <div class="link-text">
              <p class="link-text-value">Zena CLI <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
    </div>
  </div>
</div>

<div class="home-section">
  <div class="container prose">

## Language features

<details id="syntax">
  <summary>TypeScript-inspired syntax</summary>

Zena's syntax is directly inspired by TypeScript, with familiar expressions,
functions, object literals (records in Zena), classes, type annotations, strings,
template literals, destructuring/spread, enums, imports/exports, and more nearly identical to TypeScript

This familiarity makes Zena code intuitive to read and write for humans and
AI tools alike, with virtually no ramp-up time for syntax.

However, Zena deliberately diverges from JavaScript to avoid historical baggage
and add ergonomic improvements:

- `var` is block scoped, `let` is immuatble.
- Pattern-matching `match` replaces `switch`.
- `if`, `match`, `try`, `throw`, `return`, `continue`, and `break` are
  expressions.
- `if/let` and `while/let` allow local declarations, and
  along with `for/let`, allow patterns in their conditions.
- Map literals with `{key1 => value1, key2 => value2}` syntax.
- No ternary operator so there's no ambiguity with optional chaining or
  nullable type shorthand. Use `if` expressions instead.
- No `++` or `--` operators. Use `+=` and `-=` instead.
- Class accessors are grouped, forcing consistent types.
- Optional chaining doesn't require a `.`: `o?.x`, `o?()`, and `o?[k]` are all valid.
- `as` is used to rename destructured object properties, matching `import`.
  This is more clear than `:` and resolves ambiguities with pattern matching.
- No `for-of` loops. `for-in` is the iterator protocol loop.
- `from 'path' import {...};` syntax.
- Semicolons are required.

This syntax evolution helps Zena be pleasant and consistent, while still being easy to adopt.

</details>

<details id="type-system">
  <summary>Sound, static, & expressive type system</summary>

Zena is statically, strictly, and soundly typed from the ground up. Type safety
is guaranteed at compile time, and there are no runtime type errors.

Much of this is required for Zena to compile to efficient Wasm, but Zena goes
further to close common soundness holes:

- **Non-nullable references**: References are non-nullable by default. `null` is
  added to types via standard unions.
- **No implicit type coercion**: Zena does not perform implicit type coercion
- **No unchecked casts**: Downcasts are checked at runtime. This ensures runtime
  soundness.
- **No `any` type**: Because there is no Wasm GC `any` type, Zena doesn't
  include it, and never has to automatically box primitive values. Zena
  includes Wasm's `anyref` instead.
- **Restrictions on unions**: Union types cannot mix primitives, or contain
  primitives and references, to ensure that types are always runtime
  distinguishable. Unions cannot be cast to to keep casts a single runtime
  operation.
- **Generics are reified**: `Array<Foo>` and `Array<Bar>` compile to different
  types in Wasm, and type checks work with generics, like `is Array<Foo>`.
- **Guaranteed class initialization**: Zena adopts Dart-style initializer lists
  so that `this` references never escape a constructor before being fully
  initialized, so classes never lie about the types of their fields.

On top of this, Zena adds powerful and ergonomic type system features:

- **Nominal and structural typing**: Classes, interfaces, and mixins are
  nominal, while records, tuples, and functions are structural.
- **Affine types**: `Own<>` and `Borrow<>` types provide compile-time
  control over ownership and borrowing without complex lifetime annotations.
- **Distinct and opaque types**: `distinct` and `opaque` type aliases create
  new nominal names for existing types to help avoid accidentally mixing
  values that happen to share the same underlying type.
- **Extension classes**: Extension classes provide zero-cost compile-time
  wrapping for existing types.
- **Contextual inference**: Local variables and closures benefit from
  bidirectional contextual inference, reducing the need for explicit type
  annotations.
- **Unions**: Zena provides convenient union types.
- **Literal types**: Literal types allow you to write specific primitive
  values as a type, and closed sets of them as unions.
- **`this` type**: The `this` type refers to the current instance of the class,
  allowing base classes, interfaces, and mixins to refer to the current class
  without complicated f-bounded polymorphism.

This combination of type system features makes Zena safe and accurate, but also
flexible enough to feel more like a dynamic language.

</details>

<details id="garbage-collection">
  <summary>Garbage collection</summary>

Zena is a garbage-collected language, providing memory safety and developer
convenience for everyday programming. Zena compiles directly to WebAssembly GC,
so no garbage colelctor is bundled with your binary.

Uniquely, Zena pairs its garbage collector with an affine ownership system
(`Own<T>`, `Borrow<T>`), allowing safe, automatic management of foreign handles
and non-GC resources alongside standard managed objects. Zena also allows direct
WebAssembly linear memory access with the `zena:memory` library for integration
with WASI and other systems.

In the near future Zena-allocated linear memory will be automatically managed by
the affine type system, and value types will allow declaring structured data
that can live in linear memory or in the GC heap, freely mixed.

</details>

<details id="functional-programming">
  <summary>Functional programming</summary>

Zena supports many functional programming patterns, including:

- Closures and higher-order functions
- Immutable by default
- Expression-oriented control flow
- Pattern matching
- Pipelines

Lightweight, shallowly immutable data structures like records and tuples let you
write complex programs without defining classes. Inline value types, like inline
tuples, let you represent concepts like `Result<>` and `Option<>` with guaranteed
no heap allocations. The `Iterable` interface includes powerful methods like
`map`, `filter`, and `fold` so you can write declarative data transforms on
any collection, and generators make it trivial to build iterators.

Upcoming features, like tail-call elimination (`tail return`), will make using
recursion more efficient.

Control flow like `if`, `match`, `try-catch`, `return`, `throw`, `continue`, and `break` are all expressions, making it easy to compose functions and control flow.

</details>

<details id="object-oriented-programming">
  <summary>Powerful object-oriented programming</summary>

- **Classes**: Zena classes are static, and have no common base class.
- **Mixins**: Zena allows composition of classes with linearizable mixins. You
  don't need deep class hierarchies to share implementation, and there is no
  confusing multiple-inheritance resolution.
- **Sound constructors**: Zena ensures that constructors initialize all fields
  before constructor bodies run, so that partially initialized `this`
  references are never possible.
- **Immutable-by-default fields**: Fields are immutable by default. They can be
  marked as mutable with the `var` keyword.
- **Operator overloading**
- **Lexical private fields**: Private fields are lexical, and cannot be accessed
  from outside the class. The JavaScript-style `#` prefix means they never collide with public fields, and direct dispatch means they're always fast.
- **Sealed and case classes (sum types)** Sealed class hierarchies enable
  powerful pattern matching and exhaustive checking. Concise case classes let
  you define your cases with minimum boilerplate, emulating tagged enums without a different basic data structure type.
- **Extension classes** Extension classes provide zero-cost compile-time
  wrapping for existing types.
- **Symbol-keyed members** Instead of a rigid public/protected/private access
  control hierarchy, Zena allows class members to be named by symbols, which
  can be shared in any number of ways. Implement protected or friend access.

</details>

<details id="pattern-matching">
  <summary>Pattern matching</summary>

Zena’s pattern matching is powerful and pervasive. It is available in `match`,
`if`, and `while` expressions, and is the basis of destructuring in variable
declarations and function parameters.

Patterns can match on values, records, tuples, classes, interfaces, and mixins,
and can be nested to arbitrary depth. Patterns can also include guards that
refine the match with arbitrary boolean expressions.

The compiler enforces
exhaustiveness checking on `match` expressions, ensuring that all cases are
handled. Exhaustiveness checking is enforces for enums, unions, and sealed
class hierarchies.

Sealed classes in Zena let you define algebraic data types with state and
behavior in a concise and ergonomic way, built on the same abstractions as
normal classes.

</details>

<details id="generators-async">
  <summary>Generators & async functions</summary>

Zena supports both async and generator functions. The compiler optimizes them
away when consumed in their most common forms - generators in loops, and async
functions in `await` expressions.

Async cancellation is built natively into the language, travelling through a
dedicated exception channel handeable within `cancel` blocks of `try/catch/cancel/finally`. `shielded` blocks ensure asynchronous cleanup completes safely during cancellation.

</details>

<details id="ownership">
  <summary>Ownership & resource management</summary>

Zena provides both explicit and automatic resource management, for non-GC resources
like WASI file descriptors, WASI Component handles, linear-memory allocations, and
foreign pointers.

_Resource classes_ (`resource class {}`) participate in a static affine ownership system
(`Own<T>`, `Borrow<T>`). The compiler enforces strict move semantics, and borrows are
second-class and stack-bound - they cannot be stored in unmanaged references (no
complex lifetime annotations). `using` declarations provide opt-in lifecycle management
for non-affine types.

Owned resources and `using`-bound values have their `dispose()` method called exactly once upon exiting their enclosing lexical block, even across exceptions, early returns, or cancellation unwinds.

</details>

<details id="multi-value-returns">
  <summary>Multi-value returns</summary>

Zena supports multi-value returns without heap allocation. Functions can return multiple values as unboxed tuples `(T1, T2)` that are destructured at call sites.

Standard library APIs use multi-value returns to eliminate boxing overhea. For instance, `Map.get()` returns an inline `(found, value)` tuple and `Iterator.next()` returns `(hasValue, value)`. This provides presence and value retrieval in one
method call with no heap allocations.

The `??` operator works with `Option<>` and `Result<>` style inline tuples to
provide fallback for missing values.

</details>

<details id="simd">
  <summary>SIMD</summary>

Zena provides direct access to 128-bit SIMD vector instructions through the `v128`
primitive type and the `zena:simd` standard library module. Over 200 fixed-width SIMD
instructions—including `i32x4`, `f32x4`, `f64x2`, lanes, shuffles, and bitwise
operations—map directly to WebAssembly SIMD bytecode.

Future additions include typed arrays and SIMD operations on them.

</details>

<details id="value-types">
  <summary>Value types <span class="badge warning">In progress</span></summary>

Zena is expanding its support of inline tuples to include first-class value
types with unboxed storage across both records and classes.

This allows performance-critical code to use composite data structures without a
large number of heap allocations and the associated GC overhead.

Data-oriented programming will be enabled with a Zig-style MultiArrayList that
implements a Struct of Arrays (SoA) and integrates with the ownership system for
automatic memory management without GC.

</details>

<details id="wit-integration">
  <summary>First class WIT integration <span class="badge warning">In progress</span></summary>

Zena is building native compiler support for the WebAssembly Component Model and WebAssembly Interface Type (`.wit`) specifications. Rather than relying on external code generators or clumsy glue layers, the Zena compiler directly parses, types, and binds WIT world interfaces.

This enables Zena modules to import and export standard WASI interfaces and third-party components as native Zena interfaces, types, and functions with zero runtime marshaling overhead, making Zena a tier-one language for composable Wasm ecosystems.

</details>

<details id="units-of-measure">
  <summary>Units of measure <span class="badge info">Planned</span></summary>

Zena plans to incorporate type-level units of measure and dimensional analysis
(such as `Meters`, `Seconds`, `Pixels`, or `Radians`). This allows calculations to
track physical and logical dimensions at compile time, catching dimensional mismatch
bugs before code ever runs.

Units are opaque types over primitives, so there's no runtime performance penalty.

</details>

<details id="contracts">
  <summary>Contracts <span class="badge info">Planned</span></summary>

Zena plans to introduce first-class Design-by-Contract capabilities, including
function pre-conditions (`requires`), post-conditions (`ensures`), and class
invariants.

The goal is to extend contracts into the type system to incrementally add formal
methods to support automated verification. Provable contracts can be checked at
compile time and remaining conditions can be checked at runtime when enabled.

</details>

<details id="meta-programming">
  <summary>Compile-time meta-programming <span class="badge info">Planned</span></summary>

Zena will introduce a hygienic, type-safe, compile-time macro and meta-programming
system that executes during compilation. Macros will be keyed off of a JavaScript
decorator-like syntax and run in separate, restricted Wasm containers for safety.

For a lighter-weight alternative to full macros, restricted, pure Zena `const`
evaluation will be available in a Dart-like `const` or Zig-like comptime
system.

</details>

<details id="declarative-syntaxes">
  <summary>Declarative syntax(es) <span class="badge info">Planned</span></summary>

Zena supports tagged template literals for embedded langauges like HTML and SQL,
and will add support for richer, Zena-specific declarative syntaxes, for
example JSX or a Kotlin builder-style syntax, for expressing hierarchical
structures, UI component trees, document markup, and even database queries in an
intuitive, readable, and safe format.

</details>

## Examples

Explore Zena's features through interactive examples. All examples are editable and runnable in WebAssembly.

<zena-example-playground>

<figure>
<figcaption>Functions</figcaption>

```zena
// Top-level declarations use `function` (never a closure):
function greet(name: String, prefix: String = 'Hello'): String {
  return `${prefix}, ${name}!`;
}

export function main() {
  let names = ['Alice', 'Bob'];
  var count = 0;

  // Arrow functions are closures and can be assigned to variables
  let addCount = (text: String) => `(${count += 1}) ${text}!`;

  console.log(addCount(greet('World')));

  // Inline closures are contextually typed (`n` needs no annotation):
  let messages = names.map((n) => addCount(greet(n, 'Hi')));

  for (let msg in messages) {
    console.log(msg);
  }
}
```

</figure>

<figure>
<figcaption>Records &amp; Tuples</figcaption>

```zena
// Records are anonymous structures of named fields:
let origin = {x: 10.0, y: 20.0};

// Tuples are anonymous, ordered sets of values:
let result = (true, 'Hello');

// Record types can have optional fields
type Opts = {timeout?: i32, retry?: boolean};

function getTimeout(opts: Opts) {
  // Optional fields must be read with a default
  return opts.timeout ?? 5000;
}

export function main() {
  // Records are read with property access
  let x = origin.x;

  // Tuples are read with index access
  let isValid = result[0];

  // Optional fields are optional
  let timeout = getTimeout({});

  console.log(`${x}, ${isValid}, ${timeout}`);
}
```

</figure>

<figure>
<figcaption>Arrays</figcaption>

```zena
export function main() {
  // Array literals create a FixedArray, which is an unwrapped Wasm GC array
  let numbers: FixedArray<i32> = [10, 20, 30];

  console.log(`numbers[1]: ${numbers[1]}`);

  logInts(numbers, 'Array');

  // Growable arrays use the GrowableArray class (literal coming soon!)
  let myNumbers = new GrowableArray<i32>();
  myNumbers.push(42);

  logInts(myNumbers, 'GrowableArray');
}

// The base array interface is Array:
function logInts(numbers: Array<i32>, label: String) {
  console.log(label + ':');

  // Iteration can be done with for/in:
  for (let n in numbers) {
    console.log(`- ${n}`);
  }
}
```

</figure>

<figure>
<figcaption>Maps</figcaption>

```zena
export function main() {
  // Zena has map literals, which create a HashMap
  let scores: Map<String, i32> = {'Alice' => 95, 'Bob' => 87};

  // Maps support the [] operator, which either returns a value or _throws_, so
  // check if the value exists with .has()
  if (scores.has('Alice')) {
    console.log(`Alice scored ${scores['Alice']}`);
  }

  // To avoid throwing use .get(), which returns an inline (boolean, value)
  if (let (true, score) = scores.get('Bob')) {
    console.log(`Bob scored ${score}`);
  }

  // Add values to a Map with []=
  scores['Chris'] = 90;

  logScores(scores);
}

function logScores(scores: Map<String, i32>) {
  // Maps are iterable, yielding MapEntry with `.key` and `.value` fields
  for (let {key as name, value as score} in scores) {
    console.log(`${name}: ${score}`);
  }
}
```

</figure>

<figure>
<figcaption>Async Functions</figcaption>

```zena
import { sleep } from 'zena:time';
import { Future } from 'zena:async';

// Async functions return a Future<T> and can await other futures.
async function fetchUser(id: i32): Future<String> {
  await sleep(10);
  return `User #${id}`;
}

export async function main(): Future<void> {
  // await waits for an async function call to complete.
  let userOne = await fetchUser(1);

  // async functions return Futures when not awaited
  let userTwoFuture: Future<String> = fetchUser(2);

  // Combinators like Future.all() can wait for multiple Futures in parallel
  let [userTwo, userThree] = await Future.all([userTwoFuture, fetchUser(3)]);

  console.log(`${userOne}, ${userTwo}, ${userThree}`);
}
```

</figure>

<figure allow-unused>
<figcaption>Types</figcaption>

```zena
// Types can be primitives
let x: i32 = 123;

// Or concrete classes. FixedArray is a class
let a: FixedArray<i32> = [1, 2, 3];

// Or interface types. Map is an interface type. Mixins define interfaces too.
let m: Map<String, i32> = {'Alice' => 95, 'Bob' => 87};

// Type aliases can define new types

// Like record types:
type Point = {x: f64, y: f64};

// Tuple types:
type Pair = (String, i32);

// Literal types:
type Success = 'success';

// Union types:
type Status = 'success' | 'failure';

// Function types:
type IntToString = (x: i32) => String;

// Distinct types are new nominal names for an existing type
distinct type UserId = i32;

// Opaque types hide implementation details
opaque type RecordId = String;

// Unions can not mix primitives and references
type U = String | i32; // error
type V = String | Box<i32>; // OK
```

</figure>

<figure>
<figcaption>Classes</figcaption>

```zena
// Fields are immutable by default; `var` opts into mutation.
class Cat {
  id: String;                  // public, immutable
  #greeting = 'Meow';          // private
  var name = 'Bob';            // public, mutable
  var(#mood) mood: String;     // public getter, private setter

  new(this.id, this.name, mood: String) : #mood = mood {
    console.log(`Created cat: ${this.name}`);
  }

  sayHi(): String {
    return `${this.#greeting}, I'm ${this.name}`;
  }
}

export let main = () => {
  let cat = new Cat('c-1', 'Whiskers', 'grumpy');
  console.log(cat.sayHi());
  console.log(cat.mood);
};
```

</figure>

<figure>
<figcaption>Mixins &amp; Interfaces</figcaption>

```zena
interface Animal {
  speak(): void;
}

mixin Friendly {
  greet(name: String): void {
    console.log(`Hello, ${name}!`);
  }
}

// Classes implement interfaces explicitly and pick up behaviour with `with`.
class Dog with Friendly implements Animal {
  speak(): void {
    console.log('Woof');
  }
}

export let main = () => {
  let dog = new Dog();
  dog.speak();
  dog.greet('Zena');
};
```

</figure>

<figure>
<figcaption>Sealed Classes</figcaption>

```zena
// Sealed hierarchies are a closed set, so `match` is checked for exhaustiveness.
sealed class Expr {
  case Lit(value: i32)
  case Add(left: Expr, right: Expr)
  case Neg(operand: Expr)
}

let eval = (e: Expr): i32 => match (e) {
  case Lit {value}: value
  case Add {left, right}: eval(left) + eval(right)
  case Neg {operand}: -eval(operand)
};

export let main = () => {
  let expr = new Add(new Lit(2), new Neg(new Lit(5)));
  console.log(`${eval(expr)}`);
};
```

</figure>

<figure>
<figcaption>Pattern Matching</figcaption>

```zena
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}

// Guards run after the pattern matches; `_` is the wildcard.
let describe = (shape: Shape): String => match (shape) {
  case Circle {radius} if radius > 10.0: 'a large circle'
  case Circle: 'a circle'
  case Rect {width, height} if width == height: 'a square'
  case _: 'a rectangle'
};

export let main = () => {
  console.log(describe(new Circle(20.0)));
  console.log(describe(new Circle(5.0)));
  console.log(describe(new Rect(3.0, 3.0)));
  console.log(describe(new Rect(4.0, 5.0)));
};
```

</figure>

<figure>
<figcaption>Enums</figcaption>

```zena
// Enums are nominal wrapper types backed by integers or strings.
enum Color {
  Red,
  Green,
  Blue
}

export let main = () => {
  let color: Color = Color.Red;
  console.log(`${color == Color.Red}`);
};
```

</figure>

<figure>
<figcaption>Expression Oriented</figcaption>

```zena
let parse = (input: String): i32 => {
  if (input == 'bad') {
    throw new Error('not a number');
  }
  return input.length;
};

export let main = () => {
  // `if`, `try`, `match`, and `throw` are all expressions.
  let ok = true;
  let status = if (ok) 'Completed' else throw new Error('failed');
  console.log(status);

  let value = try {
    parse('bad')
  } catch (e) {
    -1
  };
  console.log(`${value}`);
};
```

</figure>

<figure>
<figcaption>Loops</figcaption>

```zena
export let main = () => {
  let items = [10, 20, 30];

  // `for-in` walks any Iterable.
  for (let item in items) {
    console.log(`${item}`);
  }

  // Iterator.next() returns inline (found, value) — `while let` unwraps it.
  let iterator = items.:Iterable.iterator();
  while (let (true, item) = iterator.next()) {
    console.log(`next: ${item}`);
  }
};
```

</figure>

<figure>
<figcaption>Pipelines</figcaption>

```zena
let shout = (s: String): String => `${s.asciiUpperCase()}!`;
let repeat = (s: String, times: i32): String => {
  var out = '';
  for (var i = 0; i < times; i += 1) {
    out += s;
  }
  return out;
};

export let main = () => {
  // `|>` pipes the left value into `$` on the right.
  let banner = 'zena'
    |> shout($)
    |> repeat($, 2);
  console.log(banner);
};
```

</figure>

<figure>
<figcaption>Extension Classes</figcaption>

```zena
// Extension classes add methods to a type you don't own — including primitives.
extension class IntExtensions on i32 {
  isEven(): boolean {
    return this % 2 == 0;
  }
}

// Methods resolve on the static extension type, so there is no dispatch cost.
let describe = (n: IntExtensions): String => if (n.isEven()) 'even' else 'odd';

export let main = () => {
  console.log(describe(4 as IntExtensions));
  console.log(describe(7 as IntExtensions));
};
```

</figure>

<figure>
<figcaption>Regular Expressions</figcaption>

```zena
import {regex} from 'zena:regex';

export let main = () => {
  // The `regex` template tag takes raw text — no double-escaped backslashes.
  let pattern = regex`^[a-z]+$`;
  console.log(`${pattern.test('hello')}`);
  console.log(`${pattern.test('Hello')}`);
};
```

</figure>

<figure>
<figcaption>Imports &amp; Exports</figcaption>

```zena
// Standard ES import syntax.
import {min, max} from 'zena:math';

// The Python-style form is also supported.
from 'zena:math' import {abs};

// There are no globals: everything, including `console`, is imported.
export let pi = 3.14159;

export let main = () => {
  console.log(`${min(2.0, 7.0)} ${max(2.0, 7.0)} ${abs(-3.0)} ${pi}`);
};
```

</figure>

<figure>
<figcaption>Modules</figcaption>

<script type="sample/zena" filename="main.zena">
import { add, greet } from './math.zena';

export let main = () => {
  console.log(greet('Zena Developer'));
  console.log(`1 + 2 = ${add(1, 2)}`);
};
</script>
<script type="sample/zena" filename="math.zena">
export let add = (a: i32, b: i32): i32 => a + b;
export let greet = (name: String): String => {
  return 'Hello ' + name + '!';
};
</script>

```zena
import { add, greet } from './math.zena';

export let main = () => {
  console.log(greet('Zena Developer'));
  console.log(`1 + 2 = ${add(1, 2)}`);
};
```

</figure>

</zena-example-playground>

## Project Status

Zena is under active development and not ready for any real use. Large parts of the
language and standard library are still being designed, and breaking changes
happen frequently.

<div class="status-grid">
  <div class="status-col">
    <h3>Tooling</h3>
    <table>
      <thead>
        <tr>
          <th>Area</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Bootstrap compiler (TypeScript)</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Self-hosted compiler</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>ZIR backend</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Devirtualization, RTA, GVN</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Reachability & dead code removal</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Advanced optimizations</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>CLI</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Formatter</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Test runner</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Benchmark runner</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Compiler benchmarks</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Language benchmarks</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Language server</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>IDE extensions</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Online playground</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>WASI support</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Packages</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Package manager</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="status-col">
    <h3>Language</h3>
    <table>
      <thead>
        <tr>
          <th>Feature</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Functions, closures, multi-value returns</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Records &amp; tuples</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Classes, interfaces &amp; mixins</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Operator overloading</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Enums and case classes</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Union, distinct, &amp; opaque types</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Monomophized generics</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Exceptions</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Pattern matching</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>SIMD</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Generators</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Async functions</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Async cancellation</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Values types</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Ownership, borrows, &amp; resources</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Decorators &amp; macros</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>F-bounded polymorphism</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Variance annotations</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Units of measure</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Contracts &amp; pre/post-conditions</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Context parameters</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Concurrency</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Builder syntax</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="status-col">
    <h3>Standard Library</h3>
    <table>
      <thead>
        <tr>
          <th>Module</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>String, StringReader, StringBuilder</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Arrays, Maps, Sets</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Iterables</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Math: WebAssembly intrinsics</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Math: Trigonometry, etc</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Regular expressions</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>JSON</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Async: Futures &amp; timers</td>
          <td><span class="badge success">Complete</span></td>
        </tr>
        <tr>
          <td>Streams</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>File system</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>URL</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>HTTP &amp; Fetch</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>JavaScript interop</td>
          <td><span class="badge warning">In progress</span></td>
        </tr>
        <tr>
          <td>Swift-style String revamp</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Date &amp; time</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>Signals</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
        <tr>
          <td>DOM bindings</td>
          <td><span class="badge info">Planned</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</div>

Note: "Complete" is relative to the very early stage of Zena's development. Completed items
have been implemented in their initial forms, but still need a lot more testing, documentation,
benchmarking, and optimization. All features change significantly based on feedback and real-world
usage.

## AI usage

Zena is implemented almost entirely by generative AI, with human guidance, oversight, and design.
Zena is a real language with real goals, meant to be used by real humans, but also something of a
test of how much AI can help build complex, reliable software — and not just a compiler, but the
whole ecosystem a language needs. See [Built with AI](/development/built-with-ai/).

  </div>
</div>
