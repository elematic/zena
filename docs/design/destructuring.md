# Design: Destructuring & Pattern Matching

## Overview

Destructuring allows unpacking values from data structures (Records, Tuples, Arrays, Objects) into distinct variables. In Zena, destructuring is designed as a subset of a future **Pattern Matching** system.

This document outlines the design for destructuring assignment and variable declarations, specifically addressing the syntax for renaming and nesting to avoid conflicts with type annotations.

## Goals

1.  **Ergonomics**: Provide a concise syntax for extracting data from Records and Tuples.
2.  **Clarity**: Avoid the ambiguity found in TypeScript/JavaScript where `:` is used for both renaming and type annotations.
3.  **Scalability**: Ensure the syntax is a strict subset of a full Pattern Matching system (refutable patterns).
4.  **Performance**: Destructuring of fixed-shape types (Records/Tuples) should compile to direct field accesses with zero overhead.

## Syntax Proposal

### 1. Tuple Destructuring

Tuples are destructured by position using square brackets `[...]`.

```zena
let point = [10, 20];
let [x, y] = point; // x: i32, y: i32
```

**Skipping Elements**:

```zena
let [x, , z] = [1, 2, 3]; // Skip the second element
```

**Rest/Spread** (Future):

```zena
let [head, ...tail] = [1, 2, 3, 4]; // tail is [2, 3, 4]
```

### 2. Record Destructuring

Records are destructured by name using curly braces `{...}`.

```zena
let p = {x: 10, y: 20};
let {x, y} = p;
```

### 3. Renaming (`as` vs `:`)

In TypeScript/JavaScript, renaming uses `:`:

```zena
// TypeScript
const {x: x1} = p; // Renames x to x1
```

This conflicts with type syntax. `const { x: number } = p` attempts to rename `x` to a variable named `number`, rather than checking the type.

**Zena Proposal**: Use `as` for renaming (binding).

```zena
let { x as x1, y as y1 } = p;
```

This reserves `:` for **sub-patterns** or **type guards** in the future.

### 4. Nested Destructuring

Nesting uses `:` to indicate "match the value of this field against this inner pattern".

```zena
let rect = {
  topLeft: { x: 10, y: 20 },
  bottomRight: { x: 100, y: 200 }
};

// Destructure nested fields
let {
  topLeft: { x as x1, y as y1 },
  bottomRight: { x as x2, y as y2 }
} = rect;
```

Here, `topLeft:` introduces a sub-pattern.

### 5. Defaults

Default values can be provided using `=`.

```zena
let {x, z = 0} = {x: 10}; // z is 0
```

## Comparison with Pattern Matching

Destructuring is simply **Irrefutable Pattern Matching**. The syntax used in `let` bindings must be valid patterns.

### Dart Comparison

Dart 3 introduced patterns.

- **Destructuring**: `var (a, b) = (1, 2);`
- **Records**: `var ({x: a, y: b}) = record;` (Uses `:` for binding).
- **Object Pattern**: `if (shape case Rect(width: var w, height: var h)) ...`

Dart uses `:` for field matching. Zena's proposal to use `:` for sub-patterns aligns with this, but Zena distinguishes "binding a variable" (`as var`) from "matching a structure" (`: pattern`).

### Rust Comparison

- **Structs**: `let Point { x: x1, y: y1 } = p;` (Uses `:` for binding).
- **Shorthand**: `let Point { x, y } = p;`

### Zena Pattern Grammar (Draft)

```ebnf
Pattern ::= IdentifierPattern
          | RecordPattern
          | TuplePattern
          | LiteralPattern (Refutable only)
          | WildcardPattern ('_')

IdentifierPattern ::= Identifier ('as' Identifier)?

RecordPattern ::= '{' (RecordField (',' RecordField)*)? '}'
RecordField   ::= Identifier ('as' Identifier)? ('=' Expression)?  // Shorthand & Renaming
                | Identifier ':' Pattern                           // Sub-pattern

TuplePattern  ::= '[' (Pattern (',' Pattern)*)? ']'
```

## Examples

```zena
// Simple
let { x, y } = point;

// Renaming
let { x as xVal } = point;

// Nesting
let { origin: { x, y } } = graph;

// Nesting + Renaming
let { origin: { x as x0, y as y0 } } = graph;

// Mixed Record/Tuple
let { points: [p1, p2] } = polygon;
```

## Implementation Strategy

1.  **Parser**:
    - Update `VariableDeclaration` to accept `Pattern` instead of just `Identifier`.
    - Implement `parsePattern`.
2.  **Checker**:
    - Validate patterns against the type of the initializer.
    - Bind variables introduced in the pattern to the scope.
    - Handle defaults (ensure type compatibility).
3.  **Codegen**:
    - Transform destructuring into a sequence of field accesses and local variable assignments.
    - `let { x, y } = p;` becomes:
      ```wasm
      local.get $p
      struct.get $Point $x
      local.set $x
      local.get $p
      struct.get $Point $y
      local.set $y
      ```

## Open Questions

1.  **Type Annotations in Patterns**:
    Should we allow `let { x: i32 } = p;` to assert that `x` is `i32`?
    - If `:` introduces a sub-pattern, and `i32` is a type, this could be a "Type Pattern" (check type).
    - In a `let` binding (irrefutable), this would be a static type check assertion.
    - In a `match` (refutable), this would be an `is` check.

    _Decision_: Reserve `:` for sub-patterns. If we add Type Patterns later, they will naturally fit: `{ x: TypeName }`. This confirms that we should NOT use `:` for renaming.

2.  **Computed Properties**:
    JS allows `let { [key]: val } = obj;`.
    Zena Records have fixed shapes, so computed properties don't make sense for destructuring Records. They might for Maps.

3.  **Deep Immutability**:
    Destructuring copies values into local variables. If the values are primitives, they are copied. If they are objects, the reference is copied. This is consistent with `let x = p.x`.
