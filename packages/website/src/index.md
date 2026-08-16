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
            <div class="icon">🎯</div>
            <h2 class="title">Wasm GC native</h2>
            <p class="details">Primitives, references, and arrays map straight onto Wasm GC types. No allocator, no garbage collector, and no runtime shipped in your module.</p>
            <div class="link-text">
              <p class="link-text-value">How it maps <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/performance/">
          <article class="box">
            <div class="icon">⚡</div>
            <h2 class="title">Tiny, fast binaries</h2>
            <p class="details">Aggressive dead-code elimination, devirtualization, and monomorphized generics produce compact modules with no boxing on the hot path.</p>
            <div class="link-text">
              <p class="link-text-value">The performance model <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/overview/">
          <article class="box">
            <div class="icon">📝</div>
            <h2 class="title">Familiar and predictable</h2>
            <p class="details">TypeScript-like syntax with the best ideas from Rust, Swift, Dart, and Kotlin. Real numeric types, no implicit coercion, no truthiness surprises.</p>
            <div class="link-text">
              <p class="link-text-value">The language in five minutes <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/correctness/">
          <article class="box">
            <div class="icon">🔷</div>
            <h2 class="title">Sound by construction</h2>
            <p class="details">A sound type system with no escape hatches. Non-nullable references, guaranteed initialization, exhaustive matching, and checked casts.</p>
            <div class="link-text">
              <p class="link-text-value">Correctness and safety <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/guide/overview/#borrowed-from-other-languages">
          <article class="box">
            <div class="icon">✨</div>
            <h2 class="title">Modern ergonomics</h2>
            <p class="details">Expression-oriented control flow, pattern matching, algebraic data types, multi-value returns, and pipelines for clean chaining.</p>
            <div class="link-text">
              <p class="link-text-value">Borrowed from other languages <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
      <div class="item grid-3">
        <a class="feature link" href="/reference/cli/">
          <article class="box">
            <div class="icon">🛠️</div>
            <h2 class="title">One toolchain</h2>
            <p class="details">Compiler, test runner, formatter, and language server in a single CLI, all written in Zena and running natively on Wasm.</p>
            <div class="link-text">
              <p class="link-text-value">CLI reference <span class="icon-arrow-right link-text-icon"></span></p>
            </div>
          </article>
        </a>
      </div>
    </div>
  </div>
</div>

<div class="prose container">

## Write code that already looks familiar

Every sample below is a complete program: paste one into the
[playground](/playground/) and press Run.

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

## Try it here

The compiler runs in your browser as a WebAssembly module — nothing is uploaded.
Type-checking and diagnostics come from the self-hosted Zena language server in a
background worker.

<zena-playground></zena-playground>

There is a larger editor on the [playground page](/playground/).

## An experiment in AI-built software

Zena is implemented almost entirely by generative AI, with human oversight. It is
a real language with real goals, and simultaneously a test of whether AI can
build well-constructed, reliable software — not just a compiler, but the whole
ecosystem a language needs.

That shapes the design. Static types, unusually specific diagnostics, and a
sound type system are not only good for people; they are the feedback loop an
agent needs to make progress without guessing. See
[Working with AI agents](/guide/ai-agents/).

## Where the project stands

| Phase                           | Status                                         |
| ------------------------------- | ---------------------------------------------- |
| Bootstrap compiler (TypeScript) | <span class="badge tip">Complete</span>        |
| Self-hosted compiler            | <span class="badge tip">Complete</span>        |
| ZIR optimizing backend          | <span class="badge warning">In progress</span> |
| Async functions and WASI P3     | <span class="badge info">Planned</span>        |
| In-browser playground           | <span class="badge tip">Working</span>         |
| Package manager                 | <span class="badge info">Planned</span>        |

Zena is under active development and not yet ready for production use. The
language reference describes what is implemented today; anything still being
designed is marked as such on the page.

</div>
