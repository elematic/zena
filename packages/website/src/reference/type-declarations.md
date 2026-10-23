---
title: 'Type Declarations'
description: 'Declaring type aliases, structural types, generic aliases, distinct types, and opaque types in Zena.'
---

In Zena, non-class types are declared using type declaration statements. Zena
distinguishes between **defining** new types and **aliasing** existing ones:

- **Type definitions** (`type`): Define compound structural types—records,
  tuples, function signatures, and unions—bound to a name (`type Point = {x:
f64, y: f64};`).
- **Type aliases** (`type`): Bind an alternative name or convenient synonym to
  an already-named type (`type Score = i32;`, `type StringList =
Array<String>;`).
- **Distinct types** (`distinct type`): Define new nominal types that share the
  underlying representation of an existing type with zero runtime overhead,
  preventing accidental substitution at compile time (`distinct type UserId =
i32;`).
- **Opaque types** (`opaque type`): Define encapsulated distinct types whose
  underlying representation is hidden outside their declaring file, preventing
  external code from forging values via casting.

## Defining types with type

A `type` declaration binds an identifier to a type expression:

```zena
type Name = TargetType;
```

Depending on whether `TargetType` represents a compound structural shape or an
already-named type, the declaration serves as a **structural type definition**
or a **type alias**.

### Structural type definitions

When `TargetType` is an anonymous compound type, the declaration defines a new
reusable structural type:

#### Record types

Record types describe lightweight structured objects with named fields:

```zena
type Point = {
  x: f64,
  y: f64,
};

type UserProfile = {
  id: String,
  displayName: String,
  bio?: String, // Optional field
};

let origin: Point = { x: 0.0, y: 0.0 };
```

For more details on record types and optional properties, see
[Records](/reference/records/).

#### Tuple types

Tuple types represent fixed-length, ordered sequences of heterogeneously typed
values:

```zena
type GeoCoordinate = (f64, f64);
type KeyValuePair = (String, i32);

let pos: GeoCoordinate = (37.7749, -122.4194);
```

For details on heap-allocated and inline tuples, see
[Tuples](/reference/tuples/).

#### Function types

Function types describe the signature of arrow functions and callbacks:

```zena
type Predicate<T> = (item: T) => boolean;
type EventHandler = (eventName: String, payload: String) => void;

let isPositive: Predicate<i32> = (x) => x > 0;
```

#### Union types

A `type` declaration can define a union of states, variants, or scalar values:

```zena
type Status = 'pending' | 'running' | 'completed' | 'failed';
type HttpResponse = SuccessResponse | ErrorResponse;
```

For union mechanics, narrowing rules, and nullability, see
[Unions](/reference/unions/).

### Type aliases

When `TargetType` refers to an existing named type (such as a primitive, a
class, or a parameterized collection), the declaration creates a **type
alias**—a transparent synonym:

```zena
type Score = i32;
type NameList = Array<String>;

let points: Score = 100;
let total: i32 = points; // Valid: Score and i32 are completely interchangeable
```

Type aliases are transparent: the compiler treats the alias and its target type
as identical in every way. An alias can be used interchangeably anywhere the
underlying type is expected.

### Recursive type definitions

A type definition can reference itself within structural positions (such as
record fields or function parameters) where the self-reference is guarded behind
an indirection or nullability:

```zena
type LinkedList = {
  value: i32,
  next: LinkedList | null,
};

let list: LinkedList = {
  value: 1,
  next: {
    value: 2,
    next: null,
  },
};
```

Directly circular aliases without structural wrapping (such as `type A = A;` or
`type A = B; type B = A;`) are rejected by the compiler.

## Generic type definitions

Type declarations can declare type parameters, enabling reusable parameterized
definitions:

```zena
type Pair<T> = (T, T);
type Nullable<T> = T | null;
type Transform<T, U> = (input: T) => U;

let words: Pair<String> = ('hello', 'world');
let parseNumber: Transform<String, i32> = (s) => parseInt(s);
```

### Type parameter constraints

Type parameters on type definitions can specify subtyping constraints using the
`extends` clause:

```zena
type NamedContainer<T extends HasName> = {
  item: T,
  label: String,
};
```

### Inline tuple definitions for multi-value returns

A type definition can name a tuple union, and `inline` on the name returns it
unboxed, typically for zero-cost multi-value or result returns:

```zena
type Result<T, E> = (true, T) | (false, E);

export function checkedDivide(a: i32, b: i32): inline Result<i32, String> {
  if (b == 0) {
    return (false, 'division by zero');
  }
  return (true, a / b);
}
```

Because `inline` tuples are unboxed and flattened into multiple WebAssembly
return registers, naming them with a type definition does not alter their
position restrictions: a type targeting an `inline` tuple can only be used as a
function return type. Using it on local variables, struct fields, or container
type arguments is rejected:

```zena
// Compile error: Inline tuple types can only appear in function return types
let bad: Result<i32, String> = checkedDivide(10, 2);
```

To capture an inline tuple return value, use pattern destructuring:

```zena
if (let (true, value, _) = checkedDivide(10, 2)) {
  println(`Result: ${value}`);
}
```

## Distinct types with distinct type

A `distinct type` declaration creates a new nominal type that shares the exact
underlying representation of its target type, but is treated as a separate,
incompatible type by the compiler:

```zena
distinct type UserId = i32;
distinct type OrderId = i32;
distinct type Milliseconds = i64;
distinct type Meters = f64;
```

### Compile-time distinction without runtime cost

Distinct types provide domain safety by preventing accidental substitution:

```zena
let userId = 42 as UserId;
let orderId = 42 as OrderId;

function fetchUser(id: UserId) { ... }

fetchUser(userId);  // Valid
fetchUser(orderId); // Compile error: Type mismatch: 'OrderId' is not assignable to 'UserId'
fetchUser(42);      // Compile error: Type mismatch: 'i32' is not assignable to 'UserId'
```

At runtime, distinct types are completely erased to their underlying storage
types (`i32`, `i64`, `f64`, or reference pointers). There is no wrapper object,
no boxing allocation, and zero memory overhead.

### Nominal incompatibility between twin definitions

Even if two distinct types have identical underlying types, they are mutually
incompatible:

```zena
distinct type Width = f64;
distinct type Height = f64;

let w: Width = 100.0 as Width;
let h: Height = w; // Compile error: Type mismatch: 'Width' is not assignable to 'Height'
```

## Opaque types with opaque type

While `distinct type` prevents accidental assignment, anyone in the codebase can
convert a raw value into a distinct type by writing an explicit `as` cast:

```zena
distinct type PositiveInt = i32;

// Any file can bypass validation:
let invalid = -5 as PositiveInt;
```

An `opaque type` solves this by restricting conversions. An opaque type is a
distinct type that can only be cast **into** within the source file that
declares it:

```zena
// id.zena
export opaque type ValidId = String;

export function parseId(raw: String): ValidId {
  if (raw.length == 0) {
    throw new Error('ID cannot be empty');
  }
  // Legal: casting to ValidId inside id.zena
  return raw as ValidId;
}
```

### File-level boundary enforcement

Outside `id.zena`, explicit casts to `ValidId` are rejected at compile time:

```zena
// main.zena
import { ValidId, parseId } from './id.zena';

let valid = parseId('usr_123'); // Valid: produced by the declaring module's factory

// Compile error: Cannot cast to opaque type 'ValidId'
let forged = 'usr_fake' as ValidId;
```

This guarantees that every `ValidId` instance in the program was constructed by
`parseId` and satisfies its invariants. The declaring file serves as the single,
auditable authority for minting values.

### Allowed operations outside the declaring file

Opacity restricts _forging_ new values, not using existing ones. Outside the
declaring file, consumers may:

1. **Cast out to the underlying representation**:
   ```zena
   let rawStr: String = valid as String; // Valid
   ```
2. **Cast identical or overlapping types (redundant casts and narrowing)**:
   ```zena
   let unwrap = (id: ValidId | null): ValidId => id as ValidId; // Valid: null narrowing
   let same: ValidId = valid as ValidId;                        // Valid: redundant
   ```

Because `opaque` implies `distinct`, opaque types also enjoy zero runtime
overhead and erase directly to their backing representation.

## Conversions and casting

Values are converted between distinct types and their underlying types using the
`as` operator.

### Primitive and scalar conversions

Converting to a distinct type requires an explicit `as` cast:

```zena
distinct type Celsius = f64;
distinct type Fahrenheit = f64;

let c = 100.0 as Celsius;
let raw = c as f64;
```

Arithmetic operations on distinct types require casting to the underlying scalar
or defining explicit operator overloads:

```zena
let nextTemp = ((c as f64) + 1.0) as Celsius;
```

### Container invariance and anti-forging

Because distinct and opaque types share their representation with their
underlying types, generic containers such as `Array<T>` have identical physical
layouts in memory for `Array<i32>` and `Array<UserId>`.

However, generic collections are statically invariant. You cannot assign an
`Array<i32>` to an `Array<UserId>`:

```zena
let numbers: Array<i32> = [1, 2, 3];
let userIds: Array<UserId> = numbers; // Compile error: Type mismatch
```

Furthermore, casting a container across an opaque type boundary is caught and
rejected by the compiler as an indirect forge:

```zena
// main.zena
import { Token } from './token.zena'; // opaque type Token = i32

let rawTokens = [1, 2, 3];

// Compile error: Cannot cast to opaque type 'Token'
let forged = rawTokens as Array<Token>;
```
