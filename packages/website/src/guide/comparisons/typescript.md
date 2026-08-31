---
title: 'Zena compared to TypeScript'
description: 'How Zena compares to TypeScript: shared syntax, key departures, and a side-by-side cheat sheet.'
---

Zena builds directly on the syntax, ergonomics, and conventions of JavaScript
and TypeScript. If you know TypeScript, most Zena code will read naturally on
the first pass, and hopefully most of the differences will intuitively make
sense.

TypeScript demonstrated how much static typing could bring to a dynamic
language like JavaScript, and how good of a language JavaScript can be with more
structure and machine-assisted checking.

However, TypeScript has the constraint of being a valid superset of JavaScript
and interoperating with existing JavaScript code. It must have a gradual and
unsound type system, erase all types at compile time, and can't use types to
control emit.

Zena is designed for a different target: ahead-of-time compilation to
**WebAssembly GC**. Because Zena does not need to execute existing JavaScript
codebases or preserve JavaScript's dynamic nature, it is free to adopt a sound
type system, static classical inheritance, and immutability by default; remove
sharp edges like `this` in functions, implicit coercions, switch with
fallthrough, etc.; and add many modern language features.

## Similarities

Zena retains the syntax patterns that make TypeScript pleasant to read and
write:

- **Type annotations and inference**: `let count: i32 = 42;`, with local type
  inference allowing the omission of many annotations.
- **Arrow functions**: `(a: i32, b: i32) => a + b` with contextual typing for
  callbacks.
- **Objects/Records**: Zena keeps object literal syntax for
  lightweight records `{x: 10, y: 20}`.
- **Destructuring**: Destructuring assignment and parameters `let {x, y} =
point;`.
- **Classes**: The basics of Zena classes start from TypeScript: `class`,
  `extends`, and `implements` keywords. Fields, private fields and methods.
  `this` to reference members.
- **Generics**: Generic classes and functions with `<T>` type parameters and
  `extends` constraints.
- **Modules**: Standard `import` and `export` declarations.
- **Template literals**: String interpolation with `` `Hello, ${name}!` ``.
- **Optional chaining and null coalescing**: Safe navigation with `?.` and
  fallbacks with `??`.
- **Flow-based type narrowing**: Type checks (`is`) and null checks (`!= null`)
  narrow types across conditional branches.

## Differences

### Core

- **Numeric primitives**: Zena supports the core Wasm primitive types of `i32`,
  `i64`, `f32`, and `f64`, plus additional unsigned integer types that select
  unsigned arithmetic and narrow integer types that pack tightly into Wasm
  arrays.

- **No `undefined`**: Zena uses a single `null` value for absent reference
  values.

- **No implicit coercion or truthiness**: Operators do not perform type
  coercion. Conditions strictly require a `boolean` expression. `1 + '1'`, `if
('str')` and `if (0)` are compile errors.

- **Immutability by default**: Variables use `let` for immutable bindings and
  `var` for mutable bindings. Class fields are immutable by default. Records and
  tuples are shallowly immutable.

- **Multi-value function returns**: Functions returning inline tuples compile
  directly to Wasm native **multi-value returns**, placing values directly on
  the stack without heap allocation.

  This powers core standard library APIs:
  - `Map.get(key)` returns `(found, value)` in a single call without mixing
    primitive keys and `null` allocating or throwing.
  - `Iterator.next()` returns `(hasValue, value)` without allocating a
    `{done, value}` wrapper object or requiring two calls on each iteration.

- **Array literals create FixedArrays**: FixedArray is the lowest-cost array
  type in Zena, mapping directly to unwrapped Wasm GC arrays, so the literal
  syntax creates them. Growable arrays are created with `new GrowableArray()`
  (soon to be available with a short macro).

- **Map Literals**: Map literal syntax with fat arrows:
  `let scores = {'Alice' => 95, 'Bob' => 87};`.

- **No `++` or `--` operators**: Like Swift, Zena omits these often confusing
  operators. Use `+= 1` and `-= 1` instead.

- **`is` instead of `instanceof`**: `is` is just shorter. Zena's `is` operator
  is a runtime check as well, and works with classes, interfaces, mixins, and
  generics.

- **No regex literals**: Regular expressions are a library and use tagged
  template literals: `` regex`ab+c` ``.

### Classes

- **Nominal classes and interfaces**: Zena uses **nominal typing** for classes
  and interfaces, compared to TypeScript's structural type system. Zena records
  and tuples are still structurally typed.

- **Mixins, extension classes, case classes**: Classes support linearizable
  **mixins** (`class Button with Clickable`), concise **case classes** (`class
Point(x: f64, y: f64)`), and **extension classes** that allow you to add new
  methods to existing classes and primitives.

- **Initializaters**: Constructors are divided into member initializer lists and
  bodies. A class hierarchy's complete set of initializers runs before
  constructor bodies to ensure that no partially initialized `this` references
  to the object can escape.

- **`this` is only avalable in classes**: `this` is always lexical, never
  settable. There's no confusion about what `this` refers to.

- **Algebraic Data Types**: `sealed class` hierarchies are Zena's sum types, but
  built on the existing class system. They work with exhaustive `match()`. Case
  classes get auto-generated `operator ==` and `hashCode`.

### Functions

- **Top-level vs arrow functions**: Zena separates top-level functions from
  closures. `function` is used to declare top-level functions which can be
  passed as values, but can only reference globals. Arrow functions are closures
  and can capture local variables.

- **Optional parameters must have defaults**: To avoid mixing `null` with
  primitives and to meet Wasm's strict function arity rules, all optional
  parameters must have defaults.

- **Destructured parameters include types**: Because Zena uses `as` to rename
  destructured properties instead of JavaScript's `:`, we can use `:` in
  destructured parameters for type annotations:
  `({a: i32, x as b: i32}) => a + b`.

- **No rest parameters**: Also to meet Wasm's strict function arity rules, there
  are currently no rest parameters. They may be added in the future, by heap
  allocating a list.

### Type system

- **Reified, monomorphized generics**: Zena generics are reified via
  monomorphization. Generic types are distinguishable at runtime. A `Box<i32>`
  is not a `Box<f64>`.

- **Distinct and opaque Types**: Zero-cost nominal type aliases:
  `distinct type UserId = i32;`. Distinct types keep their base type API,
  opaque types completely hide it.

- **Affine types**: For managing non GC resources, Zena includes affine types
  with owned and borrowed references, `Own<T>` and `Borrow<T>`. Borrowed
  references are stack-bound, and `Disposable` owned references are disposed
  when their owning scope exits.

- **Primitives are not objects**: There is no top-type that includes primitives
  and references, and primitives can't be mixed with references. This eliminates
  auto-boxing and ensures that arithmetic is always on the fast path.

### Control flow

- **No `switch`**: `switch` with fallthough is a common source of bugs in
  langagues that have it. Zena uses a pattern-matching `match()` expression
  without fallthough instead.

- **Expression-oriented control flow**: `if`, `match`, `try`/`catch`, `throw`,
  `return`, `break` and `contine` can all be used in expression position.

- **Pattern matching**: Pattern matching is available across `match()`,
  `if/let`, and `while/let`.

- **`for/in` instead of `for/of`**: Zena doesn't have the legacy of JavaScript's
  key-enumerating `for/in` loop, so it uses `for/in` for regular iteration.

- **Pipeline Operator (`|>`)**: Clean left-to-right data transformations with
  the `$` placeholder: `data |> parse($) |> transform($)`.

### Concurrency

- **Future instead of Promise**: Future is the more common name among languages,
  and the term using in WASI interfaces.
- **Structured Async Cancellation**: Instead of manual `AbortSignal` forwarding,
  cancellation is automatically supported via ambient cancellation scopes. All
  `async` functions can be cancelled, and handle cancellation safely through
  dedicated `try`/`cancel`/`finally` and `shielded` regions.

## Cheat sheet

| Feature                   | TypeScript / JavaScript                 | Zena                                                                |
| :------------------------ | :-------------------------------------- | :------------------------------------------------------------------ |
| **Immutable variable**    | `const x = 10;`                         | `let x = 10;`                                                       |
| **Mutable variable**      | `let x = 10;`                           | `var x = 10;`                                                       |
| **Numeric types**         | `number` / `bigint`                     | `i32`, `i64`, `u32`, `u64`, `f32`, `f64`                            |
| **String type**           | `string`                                | `String`                                                            |
| **Nullable reference**    | `string \| null \| undefined`           | `String \| null` or `String?`\_                                     |
| **Top type**              | `any` / `unknown`                       | None. _(`anyref` for references only; use `Box<T>` for primitives)_ |
| **Conditionals**          | `const v = cond ? a : b;`               | `let v = if (cond) a else b;`                                       |
| **Truthiness check**      | `if (str) { ... }`                      | `if (str != null && str.length > 0) { ... }`                        |
| **Switch / Match**        | `switch (x) { case 1: ...; break; }`    | `match (x) { case 1: ... }`                                         |
| **Iteration**             | `for (const item of items)`             | `for (let item in items)`                                           |
| **Increment**             | `i++;` / `++i;`                         | `i += 1;`                                                           |
| **Top-level function**    | `function add(a: number, b: number) {}` | `function add(a: i32, b: i32): i32 {}`                              |
| **Local closure**         | `const add = (a, b) => a + b;`          | `let add = (a: i32, b: i32) => a + b;`                              |
| **Constructor shorthand** | `constructor(public x: number) {}`      | `x: f64; new(this.x);`                                              |
| **Mixins**                | Mixin factory functions                 | `class Dog with Friendly implements Animal`                         |
| **Map literal**           | `new Map([['a', 1]])`                   | `{'a' => 1}`                                                        |
| **Array literal**         | `[1, 2, 3]`                             | `[1, 2, 3]` _(FixedArray)_ or `Array.from([1, 2, 3])`               |
| **Type assertion**        | `x as string` _(erased at runtime)_     | `x as String` _(checked downcast)_                                  |
| **Type test**             | `x instanceof MyClass`                  | `x is MyClass` _(also `x is Array<i32>`)_                           |
| **Multi-value return**    | `return [val, true];` _(heap array)_    | `return (val, true);` _(unboxed stack tuple)_                       |
| **Resource disposal**     | `using res = getResource();`            | `using let res = getResource();`                                    |

## Next

- [Language Overview](/guide/overview/) — a rapid tour of Zena's syntax and concepts
- [What is Zena?](/guide/what-is-zena/) — an introduction to Zena's design and features
- [Quick Reference](/reference/quick-reference/) — every feature with syntax examples
