# Enums Design

## Overview

Enums provide a way to define a set of named constants. In Zena, enums are
designed to be **nominal** and **minimal**, mapping efficiently to underlying
primitive types (like `i32` or `string`) while providing type safety.

## Goals

1.  **Nominal Typing**: Enum members should be distinct from their underlying
    values to prevent accidental mixing.
2.  **Runtime Efficiency**: Enums should have minimal runtime overhead.
3.  **Grouping**: Enum members should be grouped under a namespace (the enum
    name).
4.  **Simplicity**: The syntax should be familiar (similar to TypeScript/C#).

## Syntax

```zena
enum Color {
  Red,
  Green,
  Blue
}

enum Direction {
  Up = "UP",
  Down = "DOWN"
}
```

## Semantics

An `enum` declaration introduces two entities:

1.  A **Type**: A `distinct type` that wraps a **Union of Literal Types**
    representing the member values.
2.  A **Value**: A `const` Record containing the enum members as fields.

### Desugaring

The declaration:

```zena
enum Color {
  Red,
  Green,
  Blue
}
```

Is conceptually equivalent to:

```zena
distinct type Color = 0 | 1 | 2;

const Color = {
  Red: 0 as Color,
  Green: 1 as Color,
  Blue: 2 as Color
};
```

### Backing Types

- **Integer Enums**: If no initializer is provided, or if the initializer is an
  integer, the backing type is `i32`.
  - Default values start at 0 and increment by 1.
- **String Enums**: If the initializer is a string, the backing type is
  `string`.
- **Mixed Enums**: Not supported initially. All members must be of the same
  underlying type.

### Usage

```zena
let c: Color = Color.Red;

// Error: Type 'i32' is not assignable to type 'Color'.
// let x: Color = 0;

// Error: Type 'Color' is not assignable to type 'i32'.
// let y: i32 = c;

// Explicit casting is allowed (and erased at runtime)
let z: i32 = c as i32;
```

## Implementation Details

### Parser

- Add `enum` keyword.
- Parse `EnumDeclaration`:
  - Name (Identifier)
  - Body (Block with comma-separated list of `EnumMember`).
  - `EnumMember`: Name, optional Initializer.

### Type Checker

- Register the Enum Name as a `DistinctType`.
- Register the Enum Name as a variable (Record Type).
- Validate that all members have compatible types (all `i32` or all `string`).
- Auto-assign values for missing initializers in integer enums.

### Code Generator

- **Type Emission**: `distinct type` is erased, so `Color` becomes `i32` (or
  `string`) in WASM.
- **Value Emission**: Emit a global constant Record (struct) for the enum
  object.
  - `Color.Red` compiles to a struct field access.
  - _Optimization_: Future optimization could constant-fold `Color.Red` to `0`
    directly if the field is known to be constant.

## Performance Considerations

### Type Checking

Defining an Enum as a union of literals (e.g., `0 | 1 | ... | 100`) implies that
checking assignability to the Enum type _could_ be expensive ($O(N)$).

However, because Enums are **Distinct Types**, they are nominally typed.

- `let c: Color = 0;` is invalid because `i32` is not assignable to `Color`
  (regardless of value).
- Therefore, the compiler rarely needs to check if an arbitrary integer is in
  the union during standard assignment.
- The union is primarily used for **Exhaustiveness Checking** in `match`
  expressions, where iterating the members is necessary anyway.

### Runtime Checks

Casting to an Enum using `as` is currently **unchecked** and erased at runtime.

- `let c = 100 as Color;` is valid at runtime even if `100` is not a member.
- To enforce runtime validity, a helper function (e.g., `Color.isValid(val)`)
  would be needed. The compiler could generate this function to perform an
  efficient range or set check.

### Validation

Since `as` casts are unchecked, validating external data (e.g., from JSON or
FFI) requires explicit checks.

**Future Work**: The compiler could auto-generate a `validate(val: i32): Color`
method on the Enum object. This method would check if the value is a valid
member and return it (cast to `Color`) or throw an error.

**Current Workaround**: You can use a `match` expression to validate values,
though it requires listing cases explicitly:

```zena
let val = 100;
let c: Color = match (val) {
  case 0: 0 as Color // Red
  case 1: 1 as Color // Green
  case 2: 2 as Color // Blue
  case _: throw new Error("Invalid Color")
};
```

_Note_: Zena patterns currently support literals and identifiers. Matching
against `Color.Red` directly (as a property access) is not yet supported in
patterns, so raw literals must be used.

## Design Discussion: Tagged vs. Untagged Enums

The current design describes **Untagged Enums** (sets of named constants),
similar to C# `enum` or TypeScript `enum`. However, modern languages like Rust
and Swift use **Tagged Enums** (Algebraic Data Types) as a primary feature.

### What are Tagged Enums?

Tagged Enums allow variants to carry data:

```rust
// Rust example
enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Write(String),
}
```

This is extremely powerful when combined with pattern matching.

### Overlap with Existing Features

In Zena, "Tagged Enums" overlap significantly with **Class Hierarchies** and
**Union Types**.

The Rust example above can already be modeled in Zena (verbosely):

```zena
abstract class Message {}
class Quit extends Message {}
class Move extends Message { x: i32; y: i32; ... }
class Write extends Message { text: string; ... }
```

Or using discriminating unions of records (if we add an explicit discriminator):

```zena
type Message =
  | { kind: 'Quit' }
  | { kind: 'Move', x: i32, y: i32 }
  | { kind: 'Write', text: string };
```

### The Case for Tagged Enums

If we can already do this with classes, why support Tagged Enums?

1.  **Conciseness**: The syntax is significantly shorter. Defining multiple
    small classes is boilerplate-heavy.
2.  **Sealed Semantics**: Enums are implicitly "sealed". The compiler knows
    exactly all possible variants, enabling **Exhaustiveness Checking** without
    `default` cases. (Though `sealed abstract class` can achieve this too).
3.  **Data Modeling**: It encourages modeling data as "one of N states" rather
    than "hierarchy of objects".

### Path Forward

For the initial implementation, Zena focuses on **Untagged Enums** to solve the
immediate problem of named constants and flags.

**Future Direction**: We can extend `enum` to generic ADTs later, similar to
Swift (which supports both raw values and associated values).

```zena
// Future possibility?
enum Result<T, E> {
    Ok(T),
    Err(E)
}
```

This would likely desugar into a sealed class hierarchy to be compatible with
the WASM-GC type system, but would provide the ergonomic benefits of ADTs.

## Future Extensions

- **Const Enums**: Enums that are completely erased and inlined at compile time
  (like TS `const enum`).
- **Methods**: Allowing methods on Enums (via Extension Classes?).
- **Generated Validation**: Auto-generating `isValid` or `from` methods that
  perform runtime checks.
