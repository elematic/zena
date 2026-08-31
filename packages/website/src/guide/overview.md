---
title: 'Language Overview'
description: 'The whole language in a few minutes: syntax, types, classes, pattern matching, and what Zena borrowed from where.'
---

Most of Zena in one page. If you write TypeScript, almost all of this will read
correctly on the first pass; the differences are called out where they matter.

For the exhaustive version, see the [quick reference](/reference/quick-reference/).

## Values and variables

```zena
let count = 42;        // immutable — `let` does not mean "block-scoped var"
var total = 0;         // mutable
total += 1;            // no ++ or --

let name: String = 'Zena';   // annotations optional where inference is obvious
```

Conditions take a `boolean`. There is no truthiness, and no implicit numeric
conversion:

```zena
if (count) { }          // error: i32 is not assignable to boolean
if (count != 0) { }     // fine

let x: f64 = count;         // error
let y: f64 = count as f64;  // explicit
```

## Functions

Arrow functions only — there is no `function` keyword.

```zena
let add = (a: i32, b: i32) => a + b;

let greet = (name: String, greeting: String = 'Hello'): String => {
  return `${greeting}, ${name}!`;
};

greet('world');           // trailing arguments may be omitted
```

Parameter and return types are required on top-level functions; inside a body,
inference does the work. Closures get their parameter types from context:

```zena
let names = ['Alice', 'Bob'];
let upper = names.map(n => n.toUpperCase());   // `n` is inferred
```

## Types

```zena
// Aliases name a shape. They are structural.
type Point = {x: f64, y: f64};
type Status = 'success' | 'failure';

// Distinct types are nominal — a new type, not an alias.
distinct type UserId = i32;
let id: UserId = 123 as UserId;
// let bad: UserId = 123;   // error

// Records and tuples are structural; classes and interfaces are nominal.
let origin: Point = {x: 0.0, y: 0.0};
let pair = (1, 'hello');
let {x, y} = origin;
```

Primitives are real machine types — `i32`, `i64`, `u32`, `f32`, `f64`,
`boolean`, `String`. References are non-nullable unless the type says otherwise.

## Classes

Fields are immutable by default. Constructors take `this.` parameters and an
optional initializer list, so there is no assignment boilerplate.

```zena
class Point {
  x: f64;                      // immutable (default)
  var label: String;           // mutable
  #id: i32;                    // private
  var(#hits) hits = 0;         // public getter, private setter

  new(this.x, this.label, this.#id);

  distanceTo(other: Point): f64 => abs(this.x - other.x);
}

class Pair<A, B>(first: A, second: B)   // case class: ==, hashCode generated
```

Interfaces are implemented explicitly, and mixins add behaviour:

```zena
interface Animal { speak(): void; }

mixin Friendly {
  greet(name: String): void { console.log(`Hello, ${name}!`); }
}

class Dog with Friendly implements Animal {
  speak(): void { console.log('Woof'); }
}
```

## Pattern matching

Sealed classes declare a closed set, so `match` can be checked for
exhaustiveness. Add a case and every incomplete `match` stops compiling.

```zena
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}

let area = (shape: Shape): f64 => match (shape) {
  case Circle {radius}: 3.14159 * radius * radius
  case Rect {width, height}: width * height
};

// Guards, and patterns in conditions and loops.
let describe = (shape: Shape): String => match (shape) {
  case Circle {radius} if radius > 10.0: 'a large circle'
  case Circle: 'a circle'
  case Rect {width, height} if width == height: 'a square'
  case _: 'a rectangle'
};

if (let Some {value} = maybe) { }
while (let (true, item) = iterator.next()) { }
```

## Collections

```zena
let fixed: FixedArray<i32> = [1, 2, 3];   // fixed size, a Wasm GC array
let list = Array.from([1, 2, 3]);         // growable
list.push(4);

let scores = {'Alice' => 95, 'Bob' => 87};

// Map.get returns an inline tuple of (value, found).
if (let (score, true) = scores.get('Alice')) { }

for (let item in list) { }
```

## Errors

`throw` and `try` are expressions, so they compose:

```zena
let value = try { parseJson(input) } catch (e) { defaultConfig };
let checked = if (ok) result else throw new Error('failed');
```

## Libraries

ES-style imports. There are no globals in Zena, but every module has "prelude"
imports that are always available, such as `console`, `String`, `Array`, `Map`,
and `FixedArray`.

```zena
import { min, max } from 'zena:math';

export let pi = 3.14159;
```

## Borrowed from other languages

Zena is deliberately unoriginal. Nearly every feature is something that already
proved itself somewhere else:

| From           | What Zena took                                                                             |
| -------------- | ------------------------------------------------------------------------------------------ |
| **TypeScript** | Type annotation syntax, arrow functions, structural records, ES modules, template literals |
| **Dart**       | `this.` constructor parameters, initializer lists, mixins with `on` constraints            |
| **Scala**      | Sealed hierarchies, case classes, expression orientation, `match` as an expression         |
| **Swift**      | Immutability by default, `let`/`var`, no `++`/`--`, compound assignment only               |
| **Rust**       | Exhaustive matching, ranges, distinct newtypes, explicit numeric conversion                |
| **Kotlin**     | Non-nullable references by default, expression bodies, extension-style APIs                |
| **Go**         | A small surface you can hold in your head; one obvious way to do things                    |

What Zena changed on purpose, rather than inherited:

- `let` means **immutable**, not "block-scoped mutable"
- Conditions take `boolean` — no truthiness
- No implicit numeric coercion
- No unchecked casts and no escape hatch from checking — there is no `any`,
  and primitives are never boxed implicitly
- Nothing is implicitly in scope, and types act only where they are named

The last one is the least familiar and has the widest consequences — it is what
lets the compiler check libraries in parallel and cache the results. See
[Why Zena?](/guide/why-zena/#compilation-fast-enough-to-stay-in-the-loop).

## Next

- [Your first program](/guide/first-program/) — build something end to end
- [Quick reference](/reference/quick-reference/) — every feature, with examples
- [Zena compared to TypeScript](/guide/comparisons/typescript/) — the differences in detail
