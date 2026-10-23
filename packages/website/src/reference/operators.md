---
title: 'Operators'
description: 'Operators, pipelines, expressions, and precedence in Zena.'
---

Zena provides a comprehensive set of built-in operators for arithmetic, comparison,
logical evaluation, bitwise manipulation, assignment, range creation, and pipeline
composition.

## Arithmetic

Arithmetic operators perform numerical computations on integer and floating-point
types:

| Operator | Name             | Description                                     | Example              |
| :------- | :--------------- | :---------------------------------------------- | :------------------- |
| `+`      | Addition         | Sum of numeric operands or string concatenation | `x + y`, `'a' + 'b'` |
| `-`      | Subtraction      | Difference between numeric operands             | `x - y`              |
| `*`      | Multiplication   | Product of numeric operands                     | `x * y`              |
| `/`      | Division         | Floating-point division                         | `x / y`              |
| `%`      | Modulo           | Remainder of integer division                   | `x % y`              |
| `**`     | Exponentiation   | Base raised to the power of exponent            | `2 ** 8`             |
| `-`      | Negation (unary) | Negates the numeric operand                     | `-x`                 |

### Division and modulo

Division (`/`) in Zena always returns a floating-point value (`f32` or `f64`), never
performing integer truncation:

```zena
let a: i32 = 7;
let b: i32 = 2;
let q = a / b; // 3.5 (f64)
```

The modulo operator (`%`) applies only to integer types. It is signed for signed types
(`i32`, `i64`) and unsigned for unsigned types (`u32`, `u64`):

```zena
let rem1 = -7 % 3; // -1 (signed remainder)
```

### Exponentiation

The exponentiation operator (`**`) is right-associative and binds tighter than
multiplication:

```zena
let result = 2 ** 3 ** 2; // 2 ** (3 ** 2) = 2 ** 9 = 512
```

### Operand type rules

Operands to arithmetic operators must share the same type, with one exception: mixing
`i32` and `f32` is permitted and evaluates to `f32`:

```zena
let i: i32 = 5;
let f: f32 = 2.5;
let sum = i + f; // 7.5 (f32)
```

Mixing other distinct numeric types (such as `i32` and `i64`, or `i32` and `f64`) is a
compile-time error. Operands must be converted explicitly using `as`:

```zena
let count: i32 = 10;
let factor: f64 = 1.5;
let total = (count as f64) * factor; // Explicit cast required
```

### Absence of increment and decrement operators

Zena does not have `++` or `--` operators. Use compound assignment instead:

```zena
var counter = 0;
counter += 1;
```

### Operator overloading

Classes can overload `+` and `**` by defining `operator +` and `operator **` methods.
Extension classes over primitives can similarly define `+`, `-`, and `*` (such as
lane-wise SIMD vector operations). See [Operator Overloads](/reference/classes/methods/#operator-overloads).

## Comparison and equality

Comparison operators evaluate expressions and return a `boolean`:

| Operator | Name                  | Description                                         |
| :------- | :-------------------- | :-------------------------------------------------- |
| `==`     | Equal                 | Value equality for primitives, strings, and records |
| `!=`     | Not equal             | Value inequality                                    |
| `===`    | Strict equal          | Reference identity equality                         |
| `!==`    | Strict not equal      | Reference identity inequality                       |
| `<`      | Less than             | Strict relational comparison                        |
| `<=`     | Less than or equal    | Relational comparison                               |
| `>`      | Greater than          | Strict relational comparison                        |
| `>=`     | Greater than or equal | Relational comparison                               |

### Value equality (`==` and `!=`)

The `==` and `!=` operators compare values:

- **Primitives**: Numeric and boolean types are compared by raw scalar value.
- **Strings**: Compared by content value, not reference identity.
- **Case classes**: Compared field-by-field via auto-generated `operator ==`.
- **Classes**: Checked by calling `operator ==` on the left operand if declared. If the class declares no `operator ==`, comparison currently falls back to reference equality.
- **Records and tuples**: Defined in the language model as value types with structural equality. (See the implementation note below for current compiler behavior.)

```zena
let s1 = 'hello';
let s2 = 'hel' + 'lo';
s1 == s2; // true (content equality)
```

### Strict equality (`===` and `!==`)

The `===` and `!==` operators perform identity comparisons, checking whether two
references point to the exact same heap object and bypassing any custom `operator ==`:

```zena
class Item {
  id: i32;
  new(this.id);
  operator ==(other: Item): boolean { return this.id == other.id; }
}

let a = new Item(1);
let b = new Item(1);
a == b;  // true (calls operator ==)
a === b; // false (distinct heap objects)
```

Because records and tuples are value types with no observable reference identity,
using `===` or `!==` on record or tuple operands is a compile-time error:

```zena
let r1 = {x: 1, y: 2};
let r2 = {x: 1, y: 2};
r1 === r2;
// @error: '===' compares identity; records and tuples are values — use '=='.
```

Rejecting identity comparisons statically licenses compiler transformations such as
allocation sinking, argument explosion, and projection copying without violating
identity preservation guarantees.

### Record and tuple value semantics (current and future state)

While Zena's design establishes records and tuples as pure value types, full value-type
support in the compiler is an ongoing effort.

#### Current state

- **Static rejection of identity**: The type checker treats records and tuples as
  values without identity. Attempting to compare records or tuples using `===` or `!==`
  produces a compile-time error.
- **Heap representation**: At runtime, records and non-inline tuples are currently
  allocated on the heap as WebAssembly GC structs (`WasmStruct`).
- **Runtime equality fallback**: Codegen for synthesized recursive, field-by-field
  structural equality has not yet landed. Currently, `==` on records and tuples falls
  back to pointer equality (`ref.eq`) on the underlying GC struct. Consequently, two
  distinct allocations with identical fields do not yet evaluate to `true` with `==` at
  runtime unless they refer to the same instance:

  ```zena
  let a = {x: 1, y: 2};
  let b = a;
  a == b; // true (same reference)

  let c = {x: 1, y: 2};
  // Currently false at runtime until synthesized structural equality lands:
  // a == c;
  ```

- **Unboxed inline tuples**: Zero-allocation unboxed tuples are currently limited to
  `inline (T1, T2)` function return types (multi-value returns).

#### Planned future state

- **Synthesized structural equality**: The compiler will automatically synthesize
  recursive field-by-field comparisons for `==` and `!=` across all record and tuple
  types, along with structural `hashCode` implementations for use as keys in
  `HashMap` and `HashSet`.
- **Allocation sinking and argument explosion**: Boxing will become an unobservable
  implementation detail. The compiler will sink allocations into local scalar variables,
  explode record arguments into scalar function parameters, and return multiple values
  on the stack without allocating GC structs when values do not escape.
- **Dense collection layout**: Collections of records and tuples will support dense,
  flattened storage (such as struct-of-arrays) instead of arrays of pointers to individual
  heap-allocated GC boxes.
- **Row polymorphism**: Un-spread record types will become closed by default, with width
  subtyping replaced by explicit projection copies, row-bounded generics
  (`<R extends record>`), and existential row types (`{x: i32, ...}`).

### Relational comparisons

Relational operators (`<`, `<=`, `>`, `>=`) perform signed comparisons on signed
integers (`i32`, `i64`) and unsigned comparisons on unsigned integers (`u32`, `u64`).
Comparing signed and unsigned types directly is a compile-time error; cast one to the
other first.

## Logical and null-coalescing

Logical and coalescing operators control boolean logic and null handling:

| Operator | Name                | Description                              |
| :------- | :------------------ | :--------------------------------------- |
| `!`      | Logical NOT (unary) | Inverts a boolean value                  |
| `&&`     | Logical AND         | Short-circuiting logical conjunction     |
| `\|\|`   | Logical OR          | Short-circuiting logical disjunction     |
| `??`     | Nullish coalescing  | Short-circuiting default value selection |

### Boolean requirements

Logical operators require operands of type `boolean`. Zena has no concept of truthy
or falsy values and performs no implicit coercions:

```zena
let valid = true;
let active = false;
let allowed = valid && !active; // true
```

### Short-circuiting behavior

`&&` and `||` evaluate their right-hand operand only when necessary:

- `a && b`: If `a` evaluates to `false`, `b` is not evaluated.
- `a || b`: If `a` evaluates to `true`, `b` is not evaluated.

### Nullish coalescing (`??`)

The `??` operator returns its left-hand operand if non-null; otherwise, it evaluates
and returns its right-hand operand:

```zena
let input: String? = null;
let name = input ?? 'Anonymous'; // 'Anonymous'
```

`??` has the same precedence as `||`. Zena permits mixing `??`, `||`, and `&&`
without requiring grouping parentheses.

The `??` operator handles three distinct forms:

1. **Nullable types (`T | null`)**: Returns the unwrapped value `T` or evaluates the
   fallback expression.
2. **Optional record fields**: When reading an optional field declared on a record
   type (e.g. `options.timeout`), direct access without `??` is a compile-time error.
   The field must be accessed via `??` to guarantee a default:
   ```zena
   let timeout = options.timeout ?? 3000;
   ```
3. **Protocol inline tuples**: Two-arm unions of inline tuples where the first
   element is a boolean tag (`true` or `false`) act as zero-allocation
   maybe-forms. When `??` consumes an inline tuple union:
   - **Tag check & unwrap**: If the discriminant tag at slot `0` is `true`, `??`
     unwraps and yields the payload from slot `1` directly as a value (not as a
     tuple).
   - **Lazy fallback**: If the discriminant is `false`, `??` lazily evaluates
     and returns the right-hand default expression.
   - **Error discarded**: For `Result<V, E>` (`(true, V) | (false, E)`), the
     error payload in the `false` member is discarded (`??`
     means _"value or default, regardless of why"_). To inspect the error, use
     pattern matching (`if let` or `match`) instead.
   - **Contextual typing**: The fallback expression is typed contextually by the
     surrounding expected type, allowing literals to infer their element types:
     `let tags: Array<String> = map.get('tags') ?? [];`.

   ```zena
   // Option shape (e.g. Map.get): unwraps value or returns default
   let score = scores.get('Alice') ?? 0;

   // Result shape: unwraps ok payload or returns default, discarding error
   let port = parsePort(input) ?? 8080;
   ```

   See [Tuples](/reference/tuples/#nullish-coalescing-with-) for full details on
   inline tuples, hole literals (`_`), and multi-value returns.

### Immediate coalescence for primitives

In Zena, primitive types (`i32`, `f64`, `boolean`, etc.) are unboxed and cannot
be `null`. Consequently, an optional chaining expression on a primitive result
cannot exist independently as `i32 | null` and must immediately coalesce with
`??`:

```zena
class Point {
  x: i32;
  new(this.x);
}

let p: Point? = null;
let x = p?.x ?? 0; // OK: coalesces to i32
let y = p?.x;
// @error: Optional access to a primitive requires immediate coalescence
```

## Bitwise

Bitwise operators manipulate integer bits (`i32`, `u32`, `i64`, `u64`):

| Operator | Name                 | Description                                                 |
| :------- | :------------------- | :---------------------------------------------------------- |
| `&`      | Bitwise AND          | Bitwise conjunction                                         |
| `\|`     | Bitwise OR           | Bitwise disjunction                                         |
| `^`      | Bitwise XOR          | Bitwise exclusive OR                                        |
| `<<`     | Left shift           | Shifts bits left, filling with zeros                        |
| `>>`     | Right shift          | Arithmetic shift (sign-extends signed, zero-fills unsigned) |
| `>>>`    | Unsigned right shift | Logical shift (always zero-fills)                           |

```zena
let mask = 0x0f & 0x0a; // 0x0a (10)
let flags = 0x0c | 0x03; // 0x0f (15)
let diff = 0x0c ^ 0x0a; // 0x06 (6)

let shifted = 5 << 1; // 10
let halved = 10 >> 1; // 5

let negative: i32 = -8;
let signExtended = negative >> 1; // -4 (sign bit preserved)
let zeroFilled = negative >>> 1; // 2147483644 (zero-filled)
```

Zena does not provide a unary bitwise NOT operator (`~`). To invert all bits, XOR
with all-ones (e.g. `x ^ -1` or `x ^ 0xffff_ffff`).

## Assignment and compound assignment

The assignment operator `=` binds a new value to a mutable variable, field, or index:

```zena
var x = 10;
x = 20;
```

Immutable bindings declared with `let` cannot be reassigned.

### Compound assignment

Compound assignment operators combine a binary operation with assignment:

| Operator | Operation          | Equivalent                    |
| :------- | :----------------- | :---------------------------- |
| `+=`     | Addition           | `x = x + y`                   |
| `-=`     | Subtraction        | `x = x - y`                   |
| `*=`     | Multiplication     | `x = x * y`                   |
| `/=`     | Division           | `x = x / y`                   |
| `%=`     | Modulo             | `x = x % y`                   |
| `**=`    | Exponentiation     | `x = x ** y`                  |
| `??=`    | Nullish assignment | `x = x ?? y` (short-circuits) |

The left-hand target of a compound assignment is evaluated only once:

```zena
var list = [10, 20, 30];
var index = 0;
list[index] += 5; // index evaluated once
```

The nullish assignment operator `??=` assigns the right-hand side only if the left-hand
side evaluates to `null`. If the left-hand side is already non-null, the right-hand side
is not evaluated:

```zena
var title: String? = null;
title ??= 'Default Title'; // title is now 'Default Title'

var active: String? = 'Zena';
active ??= 'Fallback'; // 'Fallback' not evaluated; active remains 'Zena'
```

## Range operators

The range operator `..` constructs half-open sequence ranges, commonly used for
slicing collections and driving `for`-in loops:

| Syntax | Range type     | Meaning                                   |
| :----- | :------------- | :---------------------------------------- |
| `a..b` | `BoundedRange` | Indices from `a` up to `b` (exclusive)    |
| `a..`  | `FromRange`    | Indices from `a` to the end of collection |
| `..b`  | `ToRange`      | Indices from 0 up to `b` (exclusive)      |
| `..`   | `FullRange`    | All indices in collection                 |

Range classes are imported from `zena:core`:

```zena
import {BoundedRange, FromRange, ToRange, FullRange, Range} from 'zena:core';

let items = [10, 20, 30, 40, 50];

let slice1 = items[1..4]; // [20, 30, 40]
let slice2 = items[2..]; // [30, 40, 50]
let slice3 = items[..2]; // [10, 20]
let copy = items[..]; // Full copy
```

Range bounds must evaluate to integers (`i32`). Expressions inside bounds are evaluated
at range creation time:

```zena
let r = (offset + 1)..(limit * 2);
```

## Pipelines and the placeholder ($)

The pipeline operator (`|>`) passes the result of the left-hand expression to the
right-hand expression. The piped value is accessed on the right via the placeholder
variable `$`:

```zena
let result = data
  |> parse($)
  |> normalize($)
  |> transform($, options)
  |> validate($, schema);
```

### The placeholder variable (`$`)

The placeholder `$` represents the value produced by the preceding stage of the
pipeline:

- **Required placeholder**: The right-hand side of `|>` must explicitly reference
  `$`. Requiring `$` allows the piped argument to be placed anywhere in the expression
  or argument list.
- **Multiple uses**: The placeholder `$` can appear multiple times in the right-hand
  expression:
  ```zena
  10 |> $ + $ // 20
  ```
- **Arbitrary expressions**: The right-hand side is not restricted to function calls;
  it can be any expression that consumes `$`:
  ```zena
  text |> $.trim()
  value |> if ($ > 0) $ else -$
  ```
- **Tuple element access**: When piping a tuple (such as from a multi-value return),
  elements can be indexed directly on `$`:
  ```zena
  getCoordinates() |> formatPoint($[0], $[1])
  ```
- **Scope restriction**: The `$` placeholder is valid only inside the right-hand side
  of a pipeline expression. Using `$` anywhere else produces a compile-time error:
  ```zena
  let x = $;
  // @error: '$' can only be used inside a pipeline expression (|>).
  ```

### Chaining and precedence

Pipelines chain from left to right. The pipeline operator has lower precedence than
arithmetic, comparison, and logical operators, but higher precedence than assignment:

```zena
let result = input |> clean($) |> process($);
```

## Operator precedence and associativity

The following table lists all Zena operators in order of precedence, from highest
(evaluated first) to lowest (evaluated last):

| Precedence | Operator                                       | Description                          | Associativity   |
| :--------- | :--------------------------------------------- | :----------------------------------- | :-------------- |
| **1**      | `.` `?.` `.[ ]` `?.[]` `[ ]` `?[]` `( )` `?()` | Member access, indexing, calls       | Left-to-right   |
| **2**      | `!` `-` (unary) `await` `throw`                | Logical NOT, negation, await, throw  | Right-to-left   |
| **3**      | `**`                                           | Exponentiation                       | Right-to-left   |
| **4**      | `*` `/` `%`                                    | Multiplication, division, modulo     | Left-to-right   |
| **5**      | `+` `-`                                        | Addition, subtraction, concatenation | Left-to-right   |
| **6**      | `as` `is`                                      | Type cast, type test                 | Left-to-right   |
| **7**      | `..`                                           | Range creation                       | Non-associative |
| **8**      | `<<` `>>` `>>>`                                | Bitwise shifts                       | Left-to-right   |
| **9**      | `<` `<=` `>` `>=`                              | Relational comparison                | Left-to-right   |
| **10**     | `==` `!=` `===` `!==`                          | Equality and identity                | Left-to-right   |
| **11**     | `&`                                            | Bitwise AND                          | Left-to-right   |
| **12**     | `^`                                            | Bitwise XOR                          | Left-to-right   |
| **13**     | `\|`                                           | Bitwise OR                           | Left-to-right   |
| **14**     | `&&`                                           | Logical AND                          | Left-to-right   |
| **15**     | `\|\|` `??`                                    | Logical OR, nullish coalescing       | Left-to-right   |
| **16**     | `\|>`                                          | Pipeline                             | Left-to-right   |
| **17**     | `=` `+=` `-=` `*=` `/=` `%=` `**=` `??=`       | Assignment, compound assignment      | Right-to-left   |

Parentheses `( )` can be used at any point to explicitly group expressions and
override operator precedence.
