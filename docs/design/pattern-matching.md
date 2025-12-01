# Pattern Matching & `instanceof` Design

## 1. Overview

Zena provides runtime type checking capabilities that are backed by the strong guarantees of the WASM-GC type system. While the language is statically typed, it supports runtime introspection of types to enable dynamic dispatch patterns, safe downcasting, and pattern matching.

## 2. `instanceof` Operator

The `instanceof` operator is the primitive mechanism for runtime type checking.

### 2.1 Semantics

`expr instanceof Type` evaluates to a `boolean`.

- It returns `true` if the runtime value of `expr` is an instance of `Type` (or a subtype).
- It returns `false` otherwise.

### 2.2 Implementation

This compiles directly to efficient WASM instructions:

- `ref.test`: Checks if a reference is of a specific heap type.
- `br_on_cast`: Branches if a cast succeeds (often used in optimized `if/else` chains).

These checks are generally O(1) and extremely fast.

### 2.3 Reified Generics

Unlike languages with type erasure (like Java or TypeScript), Zena uses **Monomorphization** for generics. This means generic instantiations are distinct runtime types.

```typescript
class Box<T> {
  value: T;
}

let b1 = new Box<i32>(1);
let b2 = new Box<string>('a');

// These are distinct types at runtime!
b1 instanceof Box<i32>; // true
b1 instanceof Box<string>; // false
```

This allows for powerful runtime differentiation of generic types.

## 3. Pattern Matching (Future Syntax)

Pattern matching is a high-level syntax that desugars into a sequence of `instanceof` checks and destructuring operations.

### 3.1 Syntax Proposal

Zena uses `match` as an **expression**.

```typescript
let area = match (shape) {
  case Circle { radius }: Math.PI * radius * radius
  case Square { side }: side * side
  case _: 0
};
```

### 3.2 Desugaring

The compiler transforms the above into:

```typescript
let $$temp = shape;
let $$result;
if ($$temp instanceof Circle) {
  let {radius} = $$temp;
  $$result = Math.PI * radius * radius;
} else if ($$temp instanceof Square) {
  let {side} = $$temp;
  $$result = side * side;
} else {
  $$result = 0;
}
// use $$result
```

### 3.3 Pattern Types

Patterns can be categorized based on whether they are guaranteed to match or not.

#### Refutable vs. Irrefutable

- **Irrefutable Patterns (Infallible)**: These patterns will _always_ match the value.
  - Used in variable declarations and assignments: `let {x, y} = point;`.
  - If the type system allows the assignment, the pattern match is guaranteed to succeed at runtime.
  - Standard destructuring in Zena is irrefutable.

- **Refutable Patterns (Fallible)**: These patterns _may_ fail to match.
  - Used in `match` cases, `if case`, and `catch` blocks.
  - Example: `case Circle { r }` is refutable because the value might be a `Square`.

#### Supported Patterns

Zena aims to support a rich set of patterns similar to modern languages like Dart and Rust:

1.  **Variable Pattern**: Matches any value and binds it to a variable.
    - `case x:` (Irrefutable in isolation, but used in refutable contexts)

2.  **Constant Pattern**: Matches a specific primitive value.
    - `case 10:`
    - `case 'hello':`
    - `case null:`

3.  **Object Pattern**: Checks the type and destructures fields.
    - `case Point { x, y }:` (Matches if instance of `Point`, then extracts `x` and `y`)
    - `case { name: 'Alice' }:` (Matches record with specific field value)

4.  **List/Array Pattern**: Matches arrays/tuples by length and elements.
    - `case [a, b]:` (Matches array of length 2)
    - `case [head, ...tail]:` (Rest pattern)

5.  **Wildcard Pattern**: Matches anything but discards the value.
    - `case _:`

6.  **Logical Patterns**: Combines other patterns.
    - `case A | B:` (Logical OR)
    - `case A & B:` (Logical AND / Intersection)

7.  **Relational Patterns**: Checks values against operators.
    - `case > 0:`
    - `case >= 10 && <= 20:`

8.  **Cast Pattern**: Checks type and casts.
    - `case x as String:`

## 5. Syntax Discussion: `match` vs `switch`

Zena deliberately chooses `match` over the traditional C-style `switch` statement.

### 5.1 Why `match`?

1.  **Expression Semantics**: `match` is an expression that returns a value. This encourages functional patterns and immutability (`let x = match(...)` vs `let x; switch(...) { case ...: x = ... }`).
2.  **No Fallthrough**: C-style `switch` statements suffer from implicit fallthrough, a common source of bugs. `match` cases are disjoint by default.
3.  **Exhaustiveness**: `match` expressions are checked for exhaustiveness by the compiler, ensuring all possible cases are handled.
4.  **Clarity**: The `match` keyword signals powerful pattern matching capabilities, distinguishing it from simple equality jumps.

### 5.2 Omission of `switch`

To keep the language simple and avoid redundant constructs, the `switch` statement is **omitted** from Zena. Developers should use `match` for all multi-way branching needs.

## 6. Function Unions & Overloading

Zena supports Union Types for functions, which allows for a pattern of "Type-Based Overloading" where a single implementation handles multiple call signatures.

### 4.1 The Problem

Traditional overloading (defining multiple functions with the same name) requires the compiler to statically resolve the correct function at the call site. This works well for static types but can be rigid.

### 4.2 The Solution: Single Implementation

Instead of multiple implementations, an author can define a single function that accepts a Union Type and uses `instanceof` (or pattern matching) to dispatch.

```typescript
// 1. Define the Union Type
type Input = i32 | string;

// 2. Single Implementation
const print = (val: Input) => {
  if (val instanceof i32) {
    // val is narrowed to i32
    console.log_i32(val);
  } else if (val instanceof string) {
    // val is narrowed to string
    console.log_string(val);
  }
};

// 3. Usage
print(42); // Works
print('hello'); // Works
```

### 4.3 Function Type Checks

Because WASM function references are typed, `instanceof` can even distinguish between function signatures.

```typescript
type Callback = ((i: i32) => void) | ((s: string) => void);

function dispatch(cb: Callback) {
  if (cb instanceof ((i: i32) => void)) {
    cb(123);
  } else {
    // Compiler knows it must be (s: string) => void
    cb("text");
  }
}
```

## 7. Summary

- **`instanceof`** is a fast, primitive WASM check.
- **Generics are reified**, allowing checks like `instanceof Box<i32>`.
- **Pattern Matching** is syntactic sugar over `instanceof` + destructuring.
- **`match`** is the chosen syntax, replacing `switch`.
- **Overloading** for user code is best implemented via Union Types and internal pattern matching, providing a flexible and "Zena-idiomatic" approach.
