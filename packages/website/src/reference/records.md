---
title: 'Records'
description: 'Record literals, structural typing, optional fields, and value semantics in Zena.'
---

Records are shallowly immutable, structural types that group a fixed set of named
fields. They provide lightweight data modeling with value semantics, compile-time
field checking, and structural subtyping without class ceremony.

::: warning Records are in transition
Records are under active development as Zena moves toward **true value types** and
**row polymorphism**:

1. **Value-type transition**: While records currently use WebAssembly GC structs
   with fat-pointer dispatch for width subtyping, identity has already been severed
   (`===` is a compile error) so that allocations can be sunk, exploded, or copied
   without breaking observable semantics.
2. **Row polymorphism roadmap**: Future work will introduce closed types by default,
   monomorphized open polymorphism (`{x: i32, ...R}`), and dense struct-of-arrays
   (SoA) layout.
3. **Immutability checking**: Record fields are semantically immutable, but the
   current type checker contains a bug where field assignments (such as `p.x = 10`)
   are not yet rejected. They will be strictly rejected in an upcoming compiler update.
   :::

## Record literals

A record literal consists of comma-separated `name: value` pairs enclosed in
curly braces (`{}`):

```zena
let origin = {x: 0, y: 0};
let user = {id: 42, name: "Alice", active: true};
```

### Property shorthand

When an expression is a variable whose name matches the field name, you can omit
the `: value` pair:

```zena
let x = 10;
let y = 20;
let point = {x, y}; // Equivalent to {x: x, y: y}
```

### Property access

Access record fields using standard dot syntax:

```zena
let x = point.x;
let y = point.y;
```

### Destructuring

Extract fields into local bindings using record destructuring patterns:

```zena
let {x, y} = point;
```

Destructuring can also rename fields during binding using `as`:

```zena
let {x as startX, y as startY} = point;
```

## Record types

A record type declares the expected field names and types within curly braces,
separated by commas or semicolons:

```zena
type Point = {x: i32, y: i32};

type User = {
  id: i32,
  name: String,
  active: boolean,
};
```

### Shallow immutability

Record fields are immutable. Reassigning a record field is intended to produce a
compile-time error:

```zena
let p = {x: 1, y: 2};
// Intended compile error:
// p.x = 10;
```

::: warning Checker bug: assignments not rejected
Immutability checking currently contains a bug: the type checker does not yet
reject direct assignments to record fields (such as `p.x = 10`). Code should
treat record fields as strictly read-only; field assignments will be rejected in
a future compiler release.
:::

Immutability is shallow: if a field holds a reference to a mutable object (such
as an array or class instance), the referenced object can still be mutated, but
the record field itself cannot be reassigned:

```zena
let container = {items: new Array<i32>()};
container.items.push(42); // Permitted: mutating referenced object
```

### Optional fields

A field marked with a trailing `?` is **optional**:

```zena
type RequestOptions = {
  url: String,
  timeout?: i32,
  retries?: i32,
};
```

#### Presence vs nullability

In Zena, optional fields represent **presence**, not nullability:

- A field marked `timeout?: i32` is either **present** (containing an `i32`) or
  **absent** (omitted entirely).
- It is not nullable. An explicit `{timeout: 0}` is present—the value `0` does
  not trigger a default.
- For a field that is always present but may hold a null value, write
  `field: T | null`. For optional values wrapped in an object, use `Option<T>`
  from `zena:core`.

#### Direct access restriction

Accessing an optional field directly using dot syntax is a compile-time error:

```zena
let getTimeout = (opts: RequestOptions): i32 => {
  return opts.timeout;
  // @error: Property 'timeout' is optional and may be absent
};
```

Because an optional field may be absent, code must inspect presence explicitly
through pattern matching or destructure with a default value.

#### Defaults in destructuring

Destructuring an optional field in a variable declaration requires providing a
default value for absent cases:

```zena
let send = (opts: RequestOptions): void => {
  let {url, timeout = 5000, retries = 3} = opts;
  // timeout and retries are guaranteed to be i32 values
};

send({url: "/api"});              // timeout = 5000, retries = 3
send({url: "/api", timeout: 200}); // timeout = 200, retries = 3
```

#### Presence patterns

In refutable contexts (`if (let ...)` or `match`), an optional field pattern
without a default tests for presence:

```zena
if (let {timeout} = opts) {
  // Branch taken only if timeout is present; binds timeout as i32
  console.log(`Custom timeout: ${timeout}`);
}
```

#### Absence patterns

Prefixing an optional field name with an exclamation mark (`!`) tests for
**absence**. The pattern matches only when the field was not provided, and binds
no variable:

```zena
let classify = (opts: RequestOptions): String => match (opts) {
  case {timeout, retries}: "both present"
  case {timeout, !retries}: "timeout only"
  case {!timeout, retries}: "retries only"
  case {!timeout, !retries}: "neither present"
  case _: "other"
};
```

Testing absence on a required field produces a compile-time error, as required
fields are never absent.

## Discriminated unions

A union of record types whose members each have a field of a different literal
type is told apart by that field:

```zena
type Outcome = {kind: 0, ok: i32} | {kind: 1, err: String};

let score = (o: Outcome): i32 => match (o) {
  case {kind: 0, ok}: ok
  case {kind: 1, err}: err.length
};

let viaIf = (o: Outcome): i32 => if (o.kind == 0) o.ok else o.err.length;
```

A record literal takes the member its literal names, a pattern with the literal
matches that member, a `match` must name every member, and comparing the field
with a literal narrows the union.

## Spread

The spread operator (`...`) unpacks fields from an existing record into a new
record literal.

### Copying and merging

Use spread to combine multiple records or add fields:

```zena
let base = {x: 10, y: 20};
let point3d = {...base, z: 30}; // {x: 10, y: 20, z: 30}

let size = {width: 100, height: 200};
let entity = {...base, ...size}; // {x: 10, y: 20, width: 100, height: 200}
```

### Override precedence

When fields with the same name appear multiple times, the last definition wins:

```zena
let original = {x: 10, y: 20};

let updated = {...original, x: 99}; // {x: 99, y: 20}
let unchanged = {x: 99, ...original}; // {x: 10, y: 20}
```

### Spreading class instances

Public fields of a class instance can be spread into a record literal:

```zena
class Point {
  x: i32;
  y: i32;
  new(this.x, this.y);
}

let pt = new Point(10, 20);
let recordPoint = {...pt, label: "origin"}; // {x: 10, y: 20, label: "origin"}
```

### Presence propagation

Spreading preserves the presence state of optional fields. If an optional field
is present in the source record, it remains present in the target; if it was
absent, it remains absent unless explicitly supplied:

```zena
type Opts = {timeout?: i32, retries?: i32};

let base: Opts = {timeout: 5};
let merged: Opts = {...base, retries: 2}; // timeout stays present (5), retries is present (2)
```

## Structural typing

Records are typed structurally. Two record types with identical field names and
types are the exact same type, regardless of how or where they are defined.

### Width subtyping

Zena supports **width subtyping** (adaptation): a record with additional fields
is a subtype of a record type that requires fewer fields:

```zena
type Point2D = {x: i32, y: i32};
type Point3D = {x: i32, y: i32, z: i32};

let getLength = (p: Point2D): i32 => p.x + p.y;

let p3: Point3D = {x: 3, y: 4, z: 5};
let result = getLength(p3); // Permitted: Point3D conforms to Point2D
```

### Value equality

Records have value semantics. The `==` and `!=` operators compare records by
their structural contents:

```zena
let a = {x: 1, y: 2};
let b = {x: 1, y: 2};

let areEqual = a == b; // true
let areDifferent = a != {x: 3, y: 4}; // true
```

Two records are equal if their fields match and each corresponding field value
is equal according to its own `==` operator.

### Identity rejection

Because records and tuples are value types, reference identity is permanently
unobservable. Using the reference identity operators `===` or `!==` on record
operands produces a compile-time error:

```zena
let a = {x: 1, y: 2};
let b = {x: 1, y: 2};

let r1 = a === b;
// @error: '===' compares identity; records and tuples are values — use '=='.

let r2 = a !== b;
// @error: '!==' compares identity; records and tuples are values — use '!='.
```

The prohibition of `===` ensures that the compiler is free to copy records,
dissolve them into scalar arguments, or re-layout their storage without
altering program behavior. Records cannot be used in identity-keyed structures
such as identity maps or weak references.

## Representation

In the current compiler implementation, records stored on the heap compile to
canonicalized WebAssembly GC structs. The compiler maintains a global registry
of shapes used across the program:

```wat
;; Canonicalized struct for {x: i32, y: i32}
(type $Record_x_y (struct
  (field $x i32)
  (field $y i32)
))
```

### Parameter explosion

When a function accepts a record parameter that does not escape to the heap, the
compiler can "explode" the record into individual scalar parameters in the
WebAssembly function signature:

```zena
let draw = (opts: {x: i32, y: i32}) => opts.x + opts.y;
```

Compiles to a WebAssembly function taking scalar arguments directly:

```wat
(func $draw (param $x i32) (param $y i32) (result i32)
  local.get $x
  local.get $y
  i32.add
)
```

This optimization eliminates heap allocations for common patterns like named
arguments and multi-field function inputs.
