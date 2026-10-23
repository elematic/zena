---
title: 'Unions'
description: 'Union types in Zena: declaration syntax, nullability, reference constraints, unboxed scalars, literal types, and type narrowing.'
---

A union type represents a value that can belong to any one of several types.
Union types in Zena are untagged, set-theoretic unions. They integrate directly
with control-flow type narrowing and pattern matching without allocating runtime
wrappers or tags.

## Declaring a union

Union types are declared using the pipe (`|`) operator to separate component
types:

```zena
type Status = 'pending' | 'running' | 'completed' | 'failed';
type ResultNode = TextNode | ElementNode;
```

Unions can be defined using `type` declarations, written inline as variable type
annotations, or used directly in function signatures:

```zena
function processPet(pet: Cat | Dog): String {
  // ...
}
```

### Union algebra and normalization

The Zena compiler normalizes union types automatically:

- **Flattening**: Nested unions are flattened into a single set of types: `(A |
B) | C` simplifies to `A | B | C`.
- **Deduplication**: Duplicate types in a union are collapsed: `Cat | Cat`
  simplifies to `Cat`.
- **Subtype absorption**: When one type in a union is a subtype of another, the
  narrower type is absorbed by the supertype: `Cat | Animal` simplifies to
  `Animal`. If nullability is present, it is preserved: `Cat | Animal?`
  simplifies to `Animal?`.
- **Bottom type absorption**: The empty type `never` represents an unreachable
  case and is absorbed: `String | never` simplifies to `String`.

## Nullability

In Zena, all reference types are non-nullable by default. A variable typed as
`String` or `MyClass` can never hold `null`.

To allow `null`, a reference type must be explicitly combined with `null` in a
union:

```zena
let name: String | null = null;
```

### The `?` shorthand

The trailing `?` modifier is the idiomatic shorthand for a union with `null`:

```zena
let name: String? = null; // Exactly equivalent to String | null
```

The shorthand `T?` is preferred for readability across declarations and
signatures.

### Precedence of `?`

The `?` modifier binds tighter than the `|` operator and tighter than a
function type's arrow (`=>`):

- `A | B?` parses as `A | (B | null)`. To make the entire union nullable,
  parenthesize the union or write `null` explicitly: `(A | B)?` or `A | B |
null`. - `() => String?` is a function returning `String | null`. To denote a
  nullable function reference, parenthesize the function type: `(() =>
String)?`.

### Primitives cannot be nullable

Scalar primitive types (`i32`, `f64`, `boolean`, `u8`, etc.) cannot be nullable.
Writing `i32?` produces a compile error:

```zena
let count: i32? = null; // Compile error: 'i32' is not nullable: primitives cannot be null
```

For storing optional primitive values, see [Why primitives are
restricted](#why-primitives-are-restricted).

## What may appear in a union

Because Zena targets WebAssembly GC and maintains a sound type system, unions
can include:

1. **Reference types**: Nominal classes, interfaces, and record types:
   ```zena
   type View = TextView | ImageView | ContainerView;
   ```
2. **Literal types**: Exact constant values of strings, numbers, or booleans:
   ```zena
   type Alignment = 'left' | 'center' | 'right';
   type Level = 1 | 2 | 3;
   type Flag = true | false;
   ```
3. **Null**: In combination with reference types or literals (`String?`, `'yes'
| 'no' | null`).
4. **Tuples told apart by a leading literal**: discriminated results, boxed
   when stored and unboxed when returned `inline`:
   ```zena
   type Result<T, E> = (true, T) | (false, E);
   ```

### Restrictions on indistinguishable types

For a union `A | B` to be soundly checked and narrowed at runtime, each branch
must have a distinct runtime representation:

- **Multiple extension classes**: You cannot create a union mixing multiple
  extension classes defined over the same underlying type, because both
  extension classes share identical runtime representations:

  ```zena
  extension class ExtA on MyClass {}
  extension class ExtB on MyClass {}

  // Compile error: multiple extension types
  let x: ExtA | ExtB;
  ```

- **Mixing inline tuples with other types**: An unboxed inline tuple union
  cannot mix inline tuples with reference or scalar types:
  ```zena
  // Compile error: cannot mix inline tuple types with other representations
  type BadUnion = inline (i32, i32) | (i32, i32);
  ```

## Why primitives are restricted

Unlike languages with a single universal top type (like `Object` or `any`), Zena
distinguishes between **unboxed machine scalars** and **garbage-collected
references**:

- **Machine scalars** (`i32`, `i64`, `f32`, `f64`, `boolean`, `v128`) are stored
  directly in CPU registers and execution stack slots.
- **Reference types** (`String`, class instances, arrays, interfaces) are
  heap-allocated objects managed by WebAssembly GC, rooted in `anyref`.

WebAssembly GC does not provide a common parent type spanning both scalar
registers and GC references. Allowing a general union like `i32 | String` would
force the compiler to implicitly box every scalar into a heap object or generate
tagged union wrappers for every assignment. Zena avoids implicit auto-boxing to
maintain predictable performance and eliminate hidden allocations.

### Explicit boxing with `Box<T>`

When a primitive value must participate in a reference union (such as an
optional integer or a heterogeneous collection), wrap it explicitly in `Box<T>`:

```zena
import { Box } from 'zena:core';

// Explicitly boxed nullable integer
let count: Box<i32>? = new Box(42);

if (count != null) {
  let n: i32 = count.value;
}
```

Explicit boxing ensures that heap allocations remain visible and intentional in
source code.

## Literal types

A literal type represents a single, exact value rather than an entire scalar
set. Zena supports literal types for strings, numbers, and booleans:

```zena
type Direction = 'north' | 'south' | 'east' | 'west';
type HttpSuccessCode = 200 | 201 | 204;
type BinaryFlag = true | false;
```

Literal types provide compile-time verification without the overhead of
allocating class or enum wrappers.

### Inference and literal widening

Zena differentiates between immutable (`let`) and mutable (`var`) bindings when
inferring literal expressions:

- **Immutable bindings (`let`)**: Retain their exact literal type:

  ```zena
  let dir = 'north'; // Inferred as the literal type 'north'

  function navigate(d: Direction) { ... }
  navigate(dir); // Valid: 'north' is assignable to Direction
  ```

- **Mutable bindings (`var`)**: Widen literals to their base scalar type:
  ```zena
  var dir = 'north'; // Widened to String
  navigate(dir);     // Compile error: 'String' is not assignable to 'Direction'
  ```

Widening enables mutable variables to be reassigned to other strings, while
literal preservation allows immutable values to satisfy specific union types
automatically.

## Narrowing a union

Control-flow type narrowing allows the compiler to refine a broad union type
into a more specific subtype within conditional code blocks.

### Null checks

Checking a nullable variable against `null` removes `null` from the union in the
non-null branch:

```zena
let formatName = (name: String?): String => {
  if (name != null) {
    // Inside this block, 'name' is narrowed to 'String'
    return name.toUpperCase();
  }
  return 'ANONYMOUS';
};
```

Narrowing works symmetrically with equality checks (`if (name == null)` narrows
to `null` in the `if` block, and `String` in the `else` block).

Null-handling operators also simplify working with nullable unions:

- **Nullish coalescing (`??`)**: `let value = name ?? 'default';`
- **Optional chaining (`?.`)**: `let len = name?.length;`
- **Nullish assignment (`??=`)**: `name ??= 'fallback';`

### Type testing with `is`

The `is` operator performs a runtime type check on reference types and narrows
the type in conditional branches:

```zena
class Cat {
  meow(): String => 'meow';
}

class Dog {
  bark(): String => 'woof';
}

let speak = (pet: Cat | Dog): String => {
  if (pet is Cat) {
    // Narrowed to Cat
    return pet.meow();
  } else {
    // Cat removed from union: narrowed to Dog
    return pet.bark();
  }
};
```

When an `is` test fails in an `if` condition, the tested type is removed from
the union in the `else` branch (subtractive union narrowing).

#### Testing against `null`

The `is` operator tests for a non-null instance of the target type. When the
operand is `null`, `x is T` always evaluates to `false`:

```zena
let pet: Cat? = null;
let isCat = pet is Cat; // Evaluates to false
```

To test for `null` specifically, use equality operators (`== null` or `!=
null`).

#### Unions cannot be `is` test targets

You cannot test whether an expression matches a compound union type:

```zena
let val: anyref = getUnknown();

// Compile error: cannot use union type as is target
if (val is (Cat | Dog)) {
  // ...
}
```

In WebAssembly GC, the `ref.test` instruction tests an object against a single
concrete heap type. It cannot test against multiple disparate heap types in one
step.

To check whether a value matches any of several types, test each type
individually with boolean operators:

```zena
if (val is Cat || val is Dog) {
  // ...
}
```

Alternatively, use a `match` expression to branch on each type:

```zena
match (val) {
  case Cat: println('cat')
  case Dog: println('dog')
  case _: println('other')
}
```

### Checked downcasts with `as`

When static analysis cannot determine a type automatically, the `as` operator
performs an explicit checked downcast:

```zena
let animal: Cat | Dog = getPet();
let dog = animal as Dog; // Runtime checked cast via wasm ref.cast; traps on mismatch
```

If the runtime object does not match the target type, the WebAssembly engine
traps with an illegal cast error.

#### Unions cannot be cast targets

You cannot cast an expression to a union type:

```zena
let val: anyref = getUnknown();

// Compile error: Cannot use union type 'Cat | Dog' as cast target. Cast to each type separately.
let pet = val as (Cat | Dog);
```

WebAssembly GC downcasts execute via the `ref.cast` instruction, which accepts a
single target heap type. WebAssembly provides no instruction to cast to a
disjunction of multiple types.

Allowing `val as (Cat | Dog)` would require the compiler to synthesize dynamic
branching (`ref.test Cat`, branch, `ref.test Dog`, branch, trap). In Zena, the
`as` operator is strictly a single-step checked downcast or representation
transition. It does not generate hidden multi-branch control flow.

To handle multiple possible target types, cast to each concrete type separately
after verifying it with `is`, or use a `match` expression.

### Pattern matching with `match`

The `match` expression provides exhaustive pattern matching over union types:

```zena
type Shape = Circle | Rectangle | Triangle;

function area(shape: Shape): f64 {
  return match (shape) {
    case Circle { radius }: 3.14159 * radius * radius
    case Rectangle { width, height }: width * height
    case Triangle { base, height }: 0.5 * base * height
  };
}
```

The compiler checks pattern exhaustiveness at compile time. If a case is omitted
without a wildcard (`case _:`) or default arm, compilation fails with an
exhaustiveness error.

### Immutable path narrowing versus mutable fields

Type narrowing applies safely to immutable paths:

- Local `let` variables.
- Immutable class fields declared with `let` or `val`.
- Record properties (records are immutable).
- Tuple elements (tuples are immutable).

Mutable class fields declared with `var` cannot be narrowed across method calls
or statement boundaries:

```zena
class State {
  var message: String?;
  new() : message = null {}

  process() {
    if (this.message != null) {
      // Compile error: cannot narrow mutable field 'this.message'
      // Another operation could set this.message = null
    }
  }
}
```

To narrow a mutable field safely, copy it to a local `let` binding first:

```zena
let msg = this.message;
if (msg != null) {
  // 'msg' is a local immutable binding and narrows to String
  println(msg.toUpperCase());
}
```

## Unions versus sealed classes

Zena provides two distinct mechanisms for working with multiple possible types:
untagged union types (`A | B`) and [sealed classes](/reference/classes/sealed/).
Choosing between them depends on whether you need an ad-hoc combination of
existing types or a closed algebraic sum type.

### Set-theoretic unions versus algebraic sum types

Union types in Zena are set-theoretic unions. A value belonging to `Cat` is
already a value of `Cat | Dog` without any wrapping or runtime tag. Because
unions represent set membership, duplicate types collapse: `Cat | Cat`
normalizes to `Cat`, and `Cat | Animal` simplifies to `Animal`.

[Sealed classes](/reference/classes/sealed/) are nominal algebraic sum types
(tagged unions). Each case in a sealed class hierarchy is a distinct nominal
type with its own runtime type tag and WebAssembly GC struct:

```zena
sealed class Shape {
  case Circle(radius: f64)
  case Square(size: f64)
}
```

Because each case has its own nominal identity, a sealed class can distinguish
variants that carry identical payload types:

```zena
sealed class Temperature {
  case Celsius(degrees: f64)
  case Fahrenheit(degrees: f64)
}
```

An untagged union cannot distinguish identical payload types. Writing `f64 |
f64` simplifies to `f64`.

### Discriminated unions

In TypeScript, sum types are commonly modeled as unions of object types with a
shared discriminant property:

```typescript
// TypeScript idiom
type Shape = {kind: 'circle'; radius: number} | {kind: 'square'; size: number};
```

In Zena, avoid this pattern for sum types. Discriminated record unions allocate
heap records without nominal type descriptors. Narrowing them requires loading
and checking string fields at runtime rather than executing WebAssembly GC type
test instructions (`ref.test`, `ref.cast`).

Use a [sealed class](/reference/classes/sealed/) instead. Sealed classes compile
to WebAssembly GC structs with native type tags, support pattern matching with
compile-time exhaustiveness checking, and allow methods to be declared directly
on the base class:

```zena
sealed class Shape {
  case Circle(radius: f64)
  case Square(size: f64)

  area(): f64 => match (this) {
    case Circle {radius}: 3.14159 * radius * radius
    case Square {size}: size * size
  };
}
```

### Comparison

| Feature                    | Union types (`A \| B`)                                    | Sealed classes (`sealed class`)           |
| :------------------------- | :-------------------------------------------------------- | :---------------------------------------- |
| **Category**               | Untagged, set-theoretic union                             | Tagged, nominal sum type                  |
| **Runtime representation** | No wrappers or tags                                       | WebAssembly GC struct with type tag       |
| **Identity**               | Structural and collapsible (`A \| A` is `A`)              | Nominal and distinct (`CaseA` != `CaseB`) |
| **Exhaustiveness**         | Checked when matching against literals or reference types | Checked across all declared cases         |
| **Declaration scope**      | Ad-hoc at any use site                                    | Declared in a single module               |
| **Behavior**               | Data only; cannot declare methods                         | Can declare methods, getters, and fields  |

### When to use each

Use union types when:

- Expressing nullability on reference types (`String?`).
- Restricting values to a set of exact literals (`'get' | 'post' | 'put'`). -
  Combining unrelated existing reference types without creating a common parent
  class (`TextView | ImageView`). - Returning discriminated results as tuples
  (`(true, T) | (false, E)`), unboxed when returned `inline`.

Use sealed classes when:

- Modeling domain data types with a fixed set of variants (such as AST nodes,
  payment methods, or state machine states).
- Variants carry payloads with identical types (`Celsius(degrees: f64)` vs
  `Fahrenheit(degrees: f64)`).
- Adding methods, computed properties, or shared state to the variants.
- Requiring a closed hierarchy that external modules cannot extend.
