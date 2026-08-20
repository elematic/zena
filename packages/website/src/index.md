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

<details>
  <summary>TypeScript-inspired syntax</summary>

  Zena's syntax is immediately recognizable to anyone who has written TypeScript, Dart, or modern JavaScript. It adopts familiar arrow functions, structural records, type annotations, template literals, and standard ES module imports and exports. This familiarity makes Zena code intuitive to read and write for developers and AI agents alike, with virtually no ramp-up time for syntax.

  However, Zena deliberately avoids JavaScript's historical baggage: `let` binds immutable values (as in Swift and Rust), conditions strictly require `boolean` expressions (no truthiness or implicit type coercion), and there are no confusing operators like `++` or loose equality. You get the concise elegance of modern web syntax paired with predictable, strict semantics.
</details>

<details>
  <summary>Sound static typing</summary>

  Unlike languages with optional or unsound type systems, Zena is strictly and soundly typed from the ground up. References are non-nullable by default (with explicit `?` nullable types), type casts are checked, and there is no unsafe `any` escape hatch to bypass checking. Local variables and closures benefit from bidirectional contextual inference, giving you safety without annotation clutter.
</details>

<details>
  <summary>Distinct types, opaque types & extension classes</summary>

  Zena provides zero-cost nominal typing mechanisms that compile directly to underlying types without runtime indirection or allocation overhead. Declaring a `distinct type` (e.g., `distinct type Meters = i32;`) creates a unique type that prevents bugs from accidentally mixing interchangeable primitives and IDs. For security-sensitive or domain-critical values, `opaque type` creates an unforgeable newtype where casts *to* the type are strictly restricted to the declaring module.

  Similarly, `extension class ... on Type` acts as a zero-cost compile-time wrapper that customizes member resolution. It allows you to enrich existing types—including built-in primitives, arrays, records, and library classes—with new methods, computed properties, and constructors without modifying their original definitions or introducing runtime wrapper allocations.
</details>

<details>
  <summary>Value types <span class="badge warning">In progress</span></summary>

  Zena is expanding its type system to support first-class value types with inline, unboxed storage. While objects are managed by the host garbage collector by default, value types provide deterministic, copy-on-write stack layouts and flat memory representations without pointer indirection.

  This allows performance-critical algorithms, geometric calculations, and numerical workloads to define composite data structures (such as `Vec3`, `Matrix4x4`, or high-frequency telemetry events) that achieve bare-metal efficiency without generating GC pressure or heap allocations.
</details>

<details>
  <summary>Garbage collection</summary>

  Zena is a garbage-collected language, providing memory safety and developer convenience for everyday programming. Automatic reference tracking and reclamation eliminate vulnerabilities like use-after-free and double-free errors without requiring lifetime annotations.

  Uniquely, Zena pairs its garbage collector with an affine ownership system (`Own<T>`, `Borrow<T>`), allowing safe, automatic management of foreign handles and non-GC resources alongside standard managed objects.
</details>

<details>
  <summary>Functional programming & expression orientation</summary>

  Zena treats expressions as first-class citizens. Control flow structures like `if-else`, `match`, `try-catch`, and blocks all produce values and compose cleanly into larger expressions without temporary variable declarations. Immutability is the default for both local bindings (`let`) and class fields, encouraging pure, side-effect-free data flow.

  First-class arrow closures, lexical scoping, and rich immutable collections give functional programming patterns equal footing alongside object-oriented ones. You can model transformations and complex logic declaratively while maintaining predictable compile-time optimizations.
</details>

<details>
  <summary>Pipelines & data transformation</summary>

  Zena introduces the pipeline operator (`|>`) for readable, left-to-right data transformation chains. Instead of deeply nesting function calls or introducing ephemeral intermediate variables, pipelines pass values forward directly. The dedicated `$` placeholder allows piping values into arbitrary argument positions and method calls without anonymous closure overhead.

  This syntax bridges functional chaining and object-oriented idioms into a uniform, readable pipeline style. Whether normalizing input data, executing query pipelines, or chaining mathematical operations, code reads in the natural order of execution.
</details>

<details>
  <summary>Modern OOP, constructors & mixins</summary>

  Zena provides an ergonomic object-oriented model designed to eliminate boilerplate. Borrowing from Dart, classes feature concise constructor parameter properties (`this.field`), initializer lists, and field immutability by default. True encapsulation is supported natively through `#` private fields and flexible access control declarations (such as `var(#field) prop` for public getters with private mutation).

  Rather than relying on fragile deep class inheritance hierarchies, Zena emphasizes composition through interfaces and linearizable mixins with `on` supertype constraints. This enables expressive, reusable behavior across class families without the diamond problem or multiple-inheritance complexity.
</details>

<details>
  <summary>Pervasive pattern matching, sealed & case classes</summary>

  Data modeling in Zena leverages algebraic data types through sealed class hierarchies and concise case classes, drawing inspiration from Scala and Rust. A `sealed class` defines a closed set of subtypes, allowing the compiler to enforce compile-time exhaustiveness checking on `match` expressions—if a case is added or missing, the compiler immediately flags it.

  Pattern matching in Zena goes beyond basic switches. It supports nested record and tuple destructuring, typed patterns, and conditional `if` guards. Patterns are integrated throughout the language, including pattern-matching conditionals like `if (let Some {value} = maybe)` and `while (let (true, item) = iter.next())` loops.
</details>

<details>
  <summary>Generators, async functions & cancellation</summary>

  Zena supports generator functions (`gen`) with `yield` statements for concise, stateful creation of custom `Iterator<T>` sequences, executing lazily and lowering into zero-allocation state machines when consumed in loops.

  Asynchronous programming is built natively into the language with `async`/`await` and structured cancellation scopes. Cancellation is ambiently inherited from parent scopes and delivered deterministically at `await` checkpoints. Rather than treating cancellation as an error that can be accidentally swallowed by `catch (e)` blocks, cancellation travels through a dedicated control-flow channel. `try` blocks can include `cancel` clauses for teardown when work is abandoned, and `shielded` blocks ensure critical asynchronous cleanup completes safely during cancellation unwinds.
</details>

<details>
  <summary>Resource management & ownership</summary>

  Alongside garbage collection, Zena provides both automatic and explicit resource management models. For non-GC resources—such as WASI file descriptors, WebAssembly Component Model handles, linear-memory allocations, and foreign pointers—types declared as `resource class` participate in a static affine ownership system (`Own<T>`, `Borrow<T>`). The compiler enforces strict move semantics and automatically invokes destructors when an owned resource leaves scope without being transferred, guaranteeing prompt, deterministic reclamation without runtime leaks.

  For structured, block-scoped lifecycle management of disposable objects, Zena provides explicit `using` declarations. Any value implementing the `Disposable` protocol bound with `using` has its disposal action executed deterministically upon exiting the enclosing lexical block—unwinding in reverse declaration order even across exceptions, early returns, or cancellation unwinds.
</details>

<details>
  <summary>Multi-value returns & structural tuples</summary>

  Zena natively supports multi-value returns, mapping directly to WebAssembly's multi-value function capabilities without heap allocation. Functions can return multiple values as lightweight, unboxed tuples `(T1, T2)` that are destructured at call sites with zero runtime cost.

  Standard library APIs use this to eliminate sentinel values and boxing overhead—for instance, `Map.get()` returns an inline `(value, found)` tuple. Combined with structural records `{x: 1, y: 2}`, Zena gives you flexible, lightweight data grouping without declaring dedicated nominal classes for temporary aggregations.
</details>

<details>
  <summary>Hardware SIMD vector primitives</summary>

  Zena provides direct access to 128-bit hardware vector instructions through the `v128` primitive type and the `zena:simd` standard library module. Over 200 fixed-width SIMD instructions—including `i32x4`, `f32x4`, `f64x2`, lanes, shuffles, and bitwise operations—map directly to WebAssembly SIMD bytecode.

  This gives numerical algorithms, graphics rendering, cryptography, and scientific computing direct access to CPU vector units with zero abstraction penalty, combining the high-level syntax of a modern language with the throughput of low-level SIMD intrinsics.
</details>

<details>
  <summary>First class WIT integration <span class="badge warning">In progress</span></summary>

  Zena is building native compiler support for the WebAssembly Component Model and WebAssembly Interface Type (`.wit`) specifications. Rather than relying on external code generators or clumsy glue layers, the Zena compiler directly parses, types, and binds WIT world interfaces.

  This enables Zena modules to import and export standard WASI interfaces and third-party components as native Zena interfaces, types, and functions with zero runtime marshaling overhead, making Zena a tier-one language for composable Wasm ecosystems.
</details>

<details>
  <summary>Numeric unit types / units of measure <span class="badge info">Planned</span></summary>

  Zena plans to incorporate type-level dimensional analysis and units of measure (such as `Meters`, `Seconds`, `Pixels`, or `Radians`). This allows calculations to track physical and logical dimensions at compile time, catching dimensional mismatch bugs before code ever runs.

  Unit arithmetic is validated automatically by the compiler—multiplying distance by time produces speed, while adding meters to seconds triggers a compile error. At runtime, unit metadata is completely erased, executing as standard unboxed machine numbers with zero performance penalty.
</details>

<details>
  <summary>Contracts <span class="badge info">Planned</span></summary>

  Zena plans to introduce first-class Design-by-Contract capabilities, including function pre-conditions (`requires`), post-conditions (`ensures`), and class invariants. Contracts make interface expectations and system boundaries explicit and machine-checkable.

  Contract clauses are integrated directly into function signatures and class definitions, enabling compile-time formal verification where feasible and configurable runtime assertion checks during testing and development.
</details>

<details>
  <summary>Compile-time meta-programming <span class="badge info">Planned</span></summary>

  Zena will introduce a hygienic, compile-time macro and meta-programming system that executes during compilation. Developers can inspect AST structures, generate boilerplate, derive traits, and construct types programmatically without external build steps or source preprocessors.

  Because meta-programming executes entirely at compile time, it eliminates the performance costs, security issues, and packaging overhead of runtime reflection while preserving full IDE autocompletion, type checking, and error diagnostics.
</details>

<details>
  <summary>Declarative syntax(es) <span class="badge info">Planned</span></summary>

  Zena will support embedded declarative syntaxes for expressing hierarchical structures, UI component trees, document markup, and database queries in an intuitive, readable format.

  Unlike string-based template engines or runtime interpreters, declarative blocks in Zena integrate directly into the language grammar, offering full static type checking, scoped variable bindings, and compiler-driven optimizations without runtime parsing overhead.
</details>

## Examples

Explore Zena's features through interactive examples. All examples are editable and runnable in WebAssembly.

<zena-example-playground>

<figure>
<figcaption>Functions</figcaption>

```zena
// Top-level functions are declared with the `function` keyword:
function greet (name: String, prefix: String = 'Hello') {
  return `${prefix}, ${name}`;
}

// Closures can be written with arrow syntax:
let add = (a: i32, b: i32): i32 => a + b;

export function main() {
  console.log(greet('Zena'));
  console.log(greet('Zena', 'Hi'));

  let names = ['Alice', 'Bob'];

  // Inline closures are contextually typed — `n` needs no annotation.
  let upper = names.map((n) => n.asciiUpperCase());

  for (let n in upper) {
    console.log(n);
  }
}
```

</figure>

<figure>
<figcaption>Async Functions</figcaption>

```zena
import { sleep } from 'zena:time';

// Async functions return a Future<T> and can await other futures.
async function fetchUser(id: i32): Future<String> {
  await sleep(10);
  return `User #${id}`;
}

export async function main(): Future<void> {
  // Calling an async function starts it eagerly.
  let [userOne, userTwo] = await Future.all([fetchUser(1), fetchUser(2)]);

  console.log(`${userOne}, ${userTwo}`);
}
```

</figure>

<figure>
<figcaption>Types</figcaption>

```zena
// Aliases name a structural shape.
type Point = {x: f64, y: f64};
type Status = 'success' | 'failure';

// Distinct types are nominal — a new type, not an alias.
distinct type UserId = i32;

export let main = () => {
  let origin: Point = {x: 0.0, y: 0.0};
  let status: Status = 'success';
  let id: UserId = 123 as UserId;
  // let wrong: UserId = 123;  // error: i32 is not assignable to UserId

  console.log(`${origin.x} ${status} ${id as i32}`);
};
```

</figure>

<figure>
<figcaption>Primitives &amp; Arrays</figcaption>

```zena
export let main = () => {
  // Primitives map straight onto Wasm types — no boxed numbers.
  let count: i32 = 42;
  let factor: f64 = 3.14159;
  console.log(`${count} ${factor}`);

  // FixedArray<T> is backed directly by a Wasm GC array.
  var nums: FixedArray<i32> = [10, 20, 30];
  nums[1] = 99;
  console.log(`${nums[0]} ${nums[1]} ${nums.length}`);
};
```

</figure>

<figure>
<figcaption>Records &amp; Tuples</figcaption>

```zena
// Records have a fixed structural shape, and destructure by name.
let origin = {x: 10.0, y: 20.0};

// Functions can return unboxed tuples; destructure the call directly.
let getCoordinates = (): inline (f64, f64) => (37.77, -122.41);

export let main = () => {
  let {x, y} = origin;
  console.log(`${x}, ${y}`);

  let (lat, lng) = getCoordinates();
  console.log(`${lat}, ${lng}`);
};
```

</figure>

<figure>
<figcaption>Maps</figcaption>

```zena
export let main = () => {
  let scores: Map<String, i32> = {'Alice' => 95, 'Bob' => 87};

  // Map.get returns an inline tuple of (found, value) — no allocation.
  if (let (true, score) = scores.get('Alice')) {
    console.log(`Alice scored ${score}`);
  }

  for (let name in scores.keys()) {
    console.log(name);
  }
};
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
