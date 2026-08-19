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

## Features

Explore Zena's features through examples. Zena is designed to be familiar and readable.

<zena-code-group class="code-group vertical">

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
  var(#mood) mood = 'grumpy';  // public getter, private setter

  new(this.id, name: String) : name = name {
    console.log(`Created cat: ${this.name}`);
  }

  sayHi(): String {
    return `${this.#greeting}, I'm ${this.name}`;
  }
}

export let main = () => {
  let cat = new Cat('c-1', 'Whiskers');
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
  console.log(describe(new Rect(3.0, 3.0)));

  // Patterns bind in loops, too.
  let points = [{x: 1.0, y: 2.0}, {x: 3.0, y: 4.0}];
  for (let {x, y} in points) {
    console.log(`${x}, ${y}`);
  }
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

</zena-code-group>

## Try Zena

<zena-playground>
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
</zena-playground>

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
