---
title: 'Tuples'
description: 'Tuples, inline tuples, multi-value returns, and value semantics in Zena.'
---

Tuples are shallowly immutable, ordered collections of fixed length and
heterogeneous element types. Zena supports two forms of tuples: **boxed
tuples**, which can be stored on the heap in variables, fields, and collections,
and **inline tuples**, which exist purely on the WebAssembly stack to express
zero-allocation multi-value returns.

::: warning

Tuples are in transition Tuples are under active development as Zena
moves toward **true value types**:

1. **Value-type transition**: While regular tuples currently compile to
   WebAssembly GC structs, reference identity has already been severed (`===`
   and `!==` are compile-time errors) so the compiler can sink, explode, or
   flatten tuples freely.
2. **Immutability checking**: Tuples are semantically immutable, but the current
   type checker contains a bug where index assignments (such as `t[0] = 10`) are
   not yet rejected. They will be strictly rejected in an upcoming compiler
   update.
3. **Inline tuple indexing**: Direct element indexing (`expr[0]`) on inline
   tuples is not yet supported
   ([#155](https://github.com/elematic/zena/issues/155)); callers must
   destructure the return value.

:::

## Tuple literals

A tuple literal consists of a comma-separated list of two or more expressions
enclosed in parentheses:

```zena
let pair = (10, "hello");
let coords = (1.5, 2.5, 0.0);
let flagRecord = (true, 42, "status");
```

### Single-element tuples

Parentheses surrounding a single expression without a comma are parsed as
ordinary grouping parentheses: `(42)` evaluates to the `i32` value `42`.

To create a 1-element tuple, include a trailing comma:

```zena
let single = (42,); // 1-element tuple of type (i32,)
let grouped = (42);  // i32, not a tuple
```

### Tuple types

A tuple type specifies the types of its elements in order, enclosed in
parentheses:

```zena
type Point2D = (f64, f64);
type Entry = (String, i32, boolean);
```

Tuple types require two or more element types (or a single element followed by a
comma). A single type in parentheses `(T)` is parsed as a parenthesized type,
equivalent to `T`.

### Element indexing

Access tuple elements by zero-based integer index using square brackets (`[]`):

```zena
let point = (10, "label");

let x = point[0]; // Inferred as i32 (10)
let label = point[1]; // Inferred as String ("label")
```

#### Compile-time known indices

Because each tuple position may have a distinct type, the compiler requires the
index to be a compile-time known integer literal:

```zena
let t = (1, "hello", true);

let first = t[0];  // Typed as i32
let second = t[1]; // Typed as String
```

Accessing an index with a dynamic runtime variable that cannot be resolved at
compile time yields a union of all element types:

```zena
let getElement = (t: (i32, String), idx: i32) => {
  let val = t[idx]; // Typed as i32 | String
};
```

Accessing an index outside the bounds of the tuple produces a compile-time
error:

```zena
let t = (1, 2);
let x = t[5];
// @error: Tuple index out of bounds: 5 (tuple has 2 elements).
```

### Destructuring

Tuple destructuring unpacks elements into separate local variables:

```zena
let pair = (100, "ok");
let (code, status) = pair;
```

#### Skipping elements

Use an underscore (`_`) to ignore elements during destructuring:

```zena
let triple = (1, "ignored", true);
let (id, _, active) = triple;
```

#### Pattern matching

Tuples can be matched and destructured in `match` expressions:

```zena
let classify = (t: (i32, i32)): String => match (t) {
  case (0, 0): "origin"
  case (0, y): `on y-axis at ${y}`
  case (x, 0): `on x-axis at ${x}`
  case (x, y): `at (${x}, ${y})`
  case _: "unknown"
};
```

### Shallow immutability

Tuples are immutable. Reassigning a tuple element is intended to produce a
compile-time error:

```zena
let t = (1, "hello");
// Intended compile error:
// t[0] = 5;
```

::: warning

Checker bug: assignments not rejected Immutability checking
currently contains a bug: the type checker does not yet reject direct
assignments to tuple elements (such as `t[0] = 5`). Code should treat tuple
elements as strictly read-only; element assignments will be rejected in a future
compiler release.

:::

Immutability is shallow: if an element holds a reference to a mutable object
(such as a `GrowableArray`), the referenced object can still be mutated, but the
tuple element cannot be rebound to point to another object:

```zena
let t = (new Array<i32>(), "queue");
t[0].push(10); // Permitted: mutating referenced object
```

### Value equality

Tuples have value semantics. The `==` and `!=` operators compare tuples by their
structural contents:

```zena
let a = (1, "test");
let b = (1, "test");

let areEqual = a == b; // true
let areDifferent = a != (2, "test"); // true
```

Two tuples are equal if they have the same arity and each corresponding element
is equal according to its own `==` operator.

### Identity rejection

Because tuples are value types, reference identity is permanently unobservable.
Using the reference identity operators `===` or `!==` on tuple operands produces
a compile-time error:

```zena
let a = (1, "test");
let b = (1, "test");

let r1 = a === b;
// @error: '===' compares identity; records and tuples are values — use '=='.

let r2 = a !== b;
// @error: '!==' compares identity; records and tuples are values — use '!='.
```

The rejection of `===` allows the compiler to sink allocations, explode tuples
into separate arguments, or repack them into flat storage without altering
program semantics. Tuples cannot be keyed by identity in identity maps or weak
references.

## Inline tuples

An **inline tuple** is an unboxed tuple that lives exclusively on the
WebAssembly stack:

```zena
let minMax = (a: i32, b: i32): inline (i32, i32) => {
  if (a < b) (a, b) else (b, a)
};
```

The `inline` keyword instructs the compiler to lower the tuple directly to
native WebAssembly multi-value returns. Inline tuples incur zero heap allocations
and avoid garbage-collector overhead.

### Restrictions on inline tuples

Inline tuples exist only in execution registers and on the WebAssembly stack:

1. **Return positions only**: An inline tuple type can appear only in function
   return type annotations (or in type aliases that expand to return types):

   ```zena
   // Permitted:
   let getValues = (): inline (i32, i32) => (1, 2);
   type PairReturn = inline (i32, i32);

   // Compile-time errors:
   type BadParam = (x: inline (i32, i32)) => i32; // @error
   type BadField = {data: inline (i32, i32)};       // @error
   type BadArray = Array<inline (i32, i32)>;        // @error
   ```

2. **Storing boxes**: destructuring the result at the call site uses the values
   directly. Storing it as a whole, in a variable, field or array, or passing
   it as an argument, allocates its boxed tuple. Returning a boxed tuple from a
   function with an inline result reads its elements back out.

   ```zena
   let (lo, hi) = minMax(10, 20);  // no allocation
   let result = minMax(10, 20);    // result is a boxed (i32, i32)
   ```

   A function value does not convert: `() => inline (i32, i32)` and
   `() => (i32, i32)` have different signatures.

3. **No direct element indexing**: Inline tuples cannot currently be indexed
   directly with `expr[i]`. Extracting a single element requires destructuring
   with wildcard holes (`_`) for unused positions:

   ```zena
   // Not currently supported:
   let lo = minMax(10, 20)[0]; // @error

   // Workaround: destructure and ignore unused positions
   let (lo, _) = minMax(10, 20);
   ```

   Direct element indexing on inline tuples is tracked in
   [#155](https://github.com/elematic/zena/issues/155).

### Tagged unions and hole literals

Inline tuples are frequently combined in unions to model optional or tagged
results without heap allocations. A literal tag (such as `true` or `false`) acts
as the discriminant:

```zena
let findItem = (id: i32): inline (true, String) | inline (false, _) => {
  if (id == 42) {
    return (true, "found");
  } else {
    return (false, _);
  }
};
```

#### The hole literal `_`

In a multi-value return union where different branches return different numbers
or types of values, inactive positions are filled using the **hole literal**
`_`:

- In `(false, _)`, the second slot is unused on the `false` branch.
- The compiler emits a zero/dummy value in the WebAssembly return slot to
  satisfy function signature arity without evaluating an expression.

#### Consuming tagged inline tuples

Tagged inline unions can be consumed using pattern matching (`if (let ...)` or
`match`):

```zena
if (let (true, item) = findItem(id)) {
  console.log(`Found item: ${item}`);
}
```

The pattern matches only when the discriminant tag is `true`, safely binding
`item` only when present.

#### Alternatives to Option and Result

In many languages, optional values and fallible operations require
heap-allocated wrapper types like `Option<T>` or `Result<V, E>`. In Zena,
function returns model these as **tagged inline tuple unions** that compile
directly to WebAssembly multi-value returns with zero heap allocation:

- **Option shape**: `inline (true, T) | inline (false, _)`
  Used by standard library APIs such as `Map.get(key)` and `Iterator.next()`. A
  literal `true` tag indicates presence with payload `T`; a `false` tag
  indicates absence with an empty hole `_`.
- **Result shape**: `(true, T) | (false, E)`
  The standard library defines `Result<T, E>` in `zena:core` as this union.
  Returned as `inline Result<T, E>` it costs no allocation; stored, it is a
  boxed tuple:

  ```zena
  import { Result } from 'zena:core';

  let parsePort = (s: String): inline Result<i32, String> => {
    let n = parseInt(s);
    if (n >= 1 && n <= 65535) {
      return (true, n);
    }
    return (false, "port out of range");
  };
  ```

  `T` and `E` share a position without holes: each type there gets a slot of
  its own (see below).

#### Slots of an inline union

An inline union is returned as a set of WebAssembly values, called slots. Each
position gets one slot per value type its members put there. In
`inline (true, i32) | (false, String)`, position 0 has one `i32` slot for the
tag, and position 1 has an `i32` slot and a `String` slot. A member leaves the
slots it does not use at their default (0 or null). Members with the same type
at a position share its slot, so `inline (true, String) | (false, String)` has
two slots.

A reader takes the slot that belongs to the member its pattern matches, and
finds the member from a literal. So every member must start with a literal, a
different one in each, all of the same type (booleans, or integers of one
type), and the members must have the same length:

```zena
let ok = (): inline (true, i32) | (false, String) => (true, 1);
let bad = (): inline (i32, i32) | (f64, f64) => (1, 2); // @error
let late = (): inline (i32, true) | (f64, false) => (1, true); // @error
let mixed = (): inline (true, i32) | (1, f64) => (true, 1); // @error
```

The literals must share a type because `true` and `1` are the same value at run
time.

##### Class-based counterparts

`zena:core` also has class-based forms:

- `Option<T>` (`Some<T>` and `None`)
- `Outcome<T, E>` (`Ok<T, E>` and `Err<T, E>`), for a result whose payload is
  an owned resource (`Own<R>`). A tuple cannot hold an owner yet
  ([#495](https://github.com/elematic/zena/issues/495)); everything else uses
  `Result`. The WIT bindings for futures and async results also still use
  `Outcome`.

#### Nullish coalescing with `??`

The [nullish coalescing operator
`??`](/reference/operators/#nullish-coalescing-) is not limited to nullable
references (`T | null`) and optional record fields (`record.field?`). It can
also consume **inline tuples** with a boolean tag as the first element, like a
`inline (true, V, ...) | inline (false, ...)` union:

```zena
// Option-shaped union: unwraps the value or evaluates the fallback
let hit = map.get("cache") ?? "default";

// Result-shaped union: unwraps the ok payload or evaluates the fallback
let port = parsePort(input) ?? 8080;
```

When applied to an inline tuple union:

1. **Tag inspection**: `??` inspects the boolean discriminant tag at index `0`.
2. **Unwrapping**: If the tag is `true`, `??` unwraps and yields the payload at
   index `1`. The expression evaluates directly to `T`, not a tuple.
3. **Lazy default**: If the tag is `false`, `??` evaluates the right-hand
   expression lazily and yields the default value.
4. **Error lane discarded**: For `Result<T, E>` shapes, `??` deliberately
   discards the error payload in slot `2`. The operator means _"give me the
   payload or fallback, regardless of why it failed"_. To inspect the error, use
   pattern matching instead:
   ```zena
   if (let (false, _, err) = parsePort(input)) {
     console.log(`Failed to parse port: ${err}`);
   }
   ```
5. **Contextual typing**: The fallback expression is typed contextually by the
   surrounding expected type, allowing literals to infer their element types:
   ```zena
   let tags: Array<String> = map.get("tags") ?? [];
   ```

For full details on operator precedence and interactions with other types, see
[Nullish coalescing in Operators](/reference/operators/#nullish-coalescing-).

### `inline` over a union

`inline` takes the whole union to its right, so one modifier covers every
member:

```zena
next(): inline (true, T) | (false, _);
```

Writing it on each member, `inline (true, T) | inline (false, _)`, means the
same thing. The operand may also be a name for a tuple or a union of tuples:

```zena
type Pair = (i32, i32);
let pair = (): inline Pair => (1, 2);
```

`inline` on a type that cannot be unboxed is an error: a primitive, a class, a
type parameter, `null`, an existential record, or a record (inline records are
planned). It is shallow: in `inline (i32, (i32, i32))` the inner tuple is still
boxed.

## Multi-value returns

Zena leverages WebAssembly's native multi-value return capability through inline
tuples. This enables efficient API patterns across the standard library.

### Zero-cost multiple return values

Functions can compute and return multiple independent results in registers
without allocating a heap container:

```zena
let divmod = (numerator: i32, denominator: i32): inline (i32, i32) => {
  return (numerator / denominator, numerator % denominator);
};

let (quotient, remainder) = divmod(17, 5); // 3, 2
```

### Iterator protocol

The standard `Iterator<T>` interface in `zena:iterator` defines `next()` using
an inline tuple union:

```zena
export interface Iterator<T> {
  next(): inline (true, T) | inline (false, _);
}
```

Because `next()` is called on every loop iteration, using an inline tuple avoids
allocating an object wrapper (such as JavaScript's `{value, done}`) per element:

```zena
while (let (true, item) = iterator.next()) {
  process(item);
}
```

### Map lookups

Map types use inline tuples to return whether a key is present along with its
associated value in a single non-allocating call:

```zena
get(key: K): inline (true, V) | inline (false, _);
```

This pattern avoids performing two lookups (`has()` followed by `get()`) and
avoids the heap allocation of wrapping the result in a class-based `Option<V>`
instance. Callers can consume the result via `if (let (true, v) = map.get(k))`
or provide a fallback using nullish coalescing: `map.get(k) ?? defaultValue`.

## Representation

Zena differentiates boxed tuples from inline tuples at the WebAssembly level:

### Boxed tuples

When a regular tuple is allocated or stored, the compiler generates a
canonicalized WebAssembly GC struct type corresponding to the tuple's element
types:

```wat
;; Canonicalized struct for (i32, String)
(type $Tuple_i32_String (struct
  (field $0 i32)
  (field $1 (ref $String))
))
```

Accessing elements (`t[0]`, `t[1]`) compiles directly to static WebAssembly
`struct.get` instructions.

### Inline tuples

Functions returning inline tuples compile directly to WebAssembly functions with
multiple return values:

```wat
;; Signature for (): inline (i32, i32)
(func $getCoords (result i32 i32)
  i32.const 10
  i32.const 20
)
```

At the call site, the WebAssembly engine leaves the return values on the
evaluation stack or in machine registers, where destructuring binds them
directly to local variables without heap allocation or garbage collection
tracking.

### Roadmap to true value types

While regular tuples are currently boxed as WebAssembly GC structs, their
identity is already unobservable by design (`===` is a compile error). Active
compiler work aims to:

1. **Sink and explode tuples**: Automatically dissolve regular tuples into
   scalar parameters and locals when they do not escape.
2. **Dense collection layout**: Enable struct-of-arrays (SoA) layout for arrays
   of tuples, eliminating arrays of individual pointer boxes.
