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

::: code-group

```zena [classes.zena]
import {console} from 'zena:console';

// Fields are immutable by default; `var` opts into mutation.
class Cat implements Animal {
  id: String;                  // public, immutable
  #greeting = 'Meow';          // private
  var name = 'Bob';            // public, mutable
  var(#mood) mood = 'grumpy';  // public getter, private setter

  new(this.id, name) : name = name {
    console.log(`Created cat: ${this.name}`);
  }

  sayHi(): String => `${this.#greeting}, I'm ${this.name}`;
}
```

```zena [matching.zena]
// Sealed hierarchies are exhaustively checked at compile time.
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
```

```zena [types.zena]
// Aliases describe shapes; distinct types create new nominal types.
type Point = {x: f64, y: f64};
type Status = 'success' | 'failure';

distinct type UserId = i32;

let origin: Point = {x: 0.0, y: 0.0};
let id: UserId = 123 as UserId;
// let wrong: UserId = 123;  // error: i32 is not assignable to UserId
```

```zena [collections.zena]
import {Map} from 'zena:map';
import {console} from 'zena:console';

let scores = {'Alice' => 95, 'Bob' => 87};

// Map.get returns an inline tuple of (value, found).
if (let (score, true) = scores.get('Alice')) {
  console.log(`Alice scored ${score}`);
}

for (let name in scores.keys()) {
  console.log(name);
}
```

:::

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
