---
title: 'Your First Program'
description: 'Build a small Zena program from scratch: functions, types, classes, and pattern matching.'
---

This page builds one small program, adding a language feature at a time. By the
end you'll have touched functions, inference, classes, sealed hierarchies, and
pattern matching — enough to read most Zena code.

## Hello, world

```zena [main.zena]
export function main(): i32 {
  console.log('Hello, world!');
  return 0;
}
```

```bash
zena run main.zena
```

Four things are already worth noticing:

- **`let`, not `function`.** Zena has arrow functions and nothing else. A
  function is a value bound with `let`.
- **`export`.** `main` is the entry point, so the module has to export it.
- **The return type is written.** Parameter types and return types on exported
  functions are required; inside a function body, inference does the work.

## Adding a function

```zena [main.zena]
let greet = (name: String): String => `Hello, ${name}!`;

export function main(): i32 {
  console.log(greet('world'));
  return 0;
}
```

An arrow function with an expression body returns that expression. Template
literals interpolate with `${}`, the same as JavaScript.

Parameters can have defaults, and callers may omit trailing arguments:

```zena
let greet = (name: String, greeting: String = 'Hello'): String =>
  `${greeting}, ${name}!`;

greet('world');            // "Hello, world!"
greet('world', 'Howdy');   // "Howdy, world!"
```

## Types and inference

Zena infers types for local bindings, so annotations are for the places where
they carry information:

```zena
let count = 42;          // i32
let ratio = 0.5;         // f64
let name = 'Zena';       // String
let flags = [1, 2, 3];   // FixedArray<i32>

var total = 0;           // `var` because it changes
for (let n in flags) {
  total += n;
}
```

Note what _doesn't_ happen here. There is no implicit conversion between
numeric types, so this is an error:

```zena
let n: i32 = 42;
let x: f64 = n;  // error: i32 is not assignable to f64
let y: f64 = n as f64;  // explicit conversion
```

And conditions must be `boolean` — there is no truthiness:

```zena
if (count) { }        // error: i32 is not assignable to boolean
if (count != 0) { }   // fine
```

These rules feel strict for about a day, and then they stop costing anything.
See [Types](/guide/types/).

## Structuring data

For plain data, use a **record** — a structural type with no declaration
ceremony:

```zena
type Point = {x: f64, y: f64};

let origin: Point = {x: 0.0, y: 0.0};
let {x, y} = origin;  // destructuring
```

For data with behaviour and identity, use a **class**:

```zena
class Circle {
  radius: f64;          // immutable field (the default)
  var label: String;    // mutable field

  new(this.radius, this.label);

  area(): f64 => 3.14159 * this.radius * this.radius;
}

let c = new Circle(2.0, 'small');
console.log(`${c.label}: ${c.area()}`);  // needs `import {console} …`
```

The constructor's `this.radius` parameter assigns the field directly — the
Dart shorthand for what would otherwise be a line of boilerplate per field.

## Matching on a closed set

When a value is one of a fixed set of shapes, use a **sealed class**. The
compiler then knows the full set and can check that a `match` handles all of it:

```zena [shapes.zena]
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
  case Triangle(base: f64, height: f64)
}

let area = (shape: Shape): f64 => match (shape) {
  case Circle {radius}: 3.14159 * radius * radius
  case Rect {width, height}: width * height
  case Triangle {base, height}: 0.5 * base * height
};
```

Add a fourth case to `Shape` and this `match` stops compiling until you handle
it — which is the point. Guards work too:

```zena
let describe = (shape: Shape): String => match (shape) {
  case Circle {radius} if radius > 10.0: 'a large circle'
  case Circle: 'a circle'
  case Rect {width, height} if width == height: 'a square'
  case Rect: 'a rectangle'
  case Triangle: 'a triangle'
};
```

## Putting it together

```zena [main.zena]
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}

let area = (shape: Shape): f64 => match (shape) {
  case Circle {radius}: 3.14159 * radius * radius
  case Rect {width, height}: width * height
};

export function main(): i32 {
  let shapes: FixedArray<Shape> = [
    new Circle(1.0),
    new Rect(2.0, 3.0),
    new Circle(0.5),
  ];

  var total = 0.0;
  for (let shape in shapes) {
    total += area(shape);
  }

  console.log(`Total area: ${total}`);
  return 0;
}
```

## Compiling to Wasm

```bash
zena build main.zena -o main.wasm --dce
```

`--dce` turns on dead-code elimination, which drops unused code _and types_ from
the output. Inspect the result with `wasm-tools`:

```bash
wasm-tools print main.wasm | head -40
```

You'll see your classes as Wasm GC struct types and your functions as Wasm
functions — no runtime, no allocator, no collector. That mapping is the whole
point of the language; [WebAssembly](/guide/web-assembly/) walks through it.

## Next

- [Values and variables](/guide/values-and-variables/)
- [Functions](/guide/functions/)
- [Control flow and matching](/guide/control-flow/)
