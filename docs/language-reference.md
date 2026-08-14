# Zena Language Reference

This document describes the syntax and semantics of the Zena programming
language.

> **Note**: The [website quick reference](../packages/website/src/docs/quick-reference.md)
> may be more comprehensive and up-to-date. When updating this document, please
> also update the quick reference.

## 1. Introduction

Zena is a statically typed language targeting WebAssembly (WASM-GC). It features
a TypeScript-like syntax with strict static typing and no implicit coercion.

## 1.1 Comments

Zena supports two styles of comments:

### Single-Line Comments

Single-line comments begin with `//` and continue to the end of the line.

```zena
let x = 1; // This is a single-line comment
```

### Multi-Line Comments

Multi-line comments begin with `/*` and end with `*/`. They can span multiple
lines.

```zena
/* This is a
   multi-line comment */
let x = 1;

let y /* inline comment */ = 2;
```

Even though Zena doesn't have JSDoc-like tooling yet, JSDoc-style commentds
(`/** */`, and tags like `@return` and `@param`) are reccomended for public
APIs.

## 1.2 Identifiers

Identifiers name variables, functions, classes, interfaces, mixins, and other
entities.

- Must start with a letter (`a-z`, `A-Z`), underscore (`_`), or dollar sign
  (`$`).
- Subsequent characters can be letters, digits (`0-9`), underscores, or dollar
  signs.
- Identifiers are case-sensitive.

```zena
let _private = 1;
let $variable = 2;
let camelCase = 3;
```

## 1.3 Trailing Commas

Trailing commas are allowed in all comma-separated lists enclosed by a delimiter:

- Function parameter lists: `(a: i32, b: i32,)`
- Function call arguments: `foo(1, 2,)`
- Array literals: `[1, 2, 3,]`
- Record literals: `{x: 1, y: 2,}`
- Tuple literals: `(1, 2,)`
- Map literals: `{"a" => 1, "b" => 2,}`
- Import specifiers: `import {Foo, Bar,} from 'mod';`
- Type parameters: `class Pair<K, V,>`
- Type arguments: `new Pair<i32, i32,>()`
- Record types: `{a: i32, b: i32,}`
- Tuple types: `(i32, String,)`
- Function types: `(a: i32, b: i32,) => void`
- Destructuring patterns: `let {x, y,} = point;`
- Class/case class parameters: `class Point(x: f64, y: f64,)`
- Match patterns: `case Foo {a, b,}: ...`
- Decorator arguments: `@external('mod', 'fn',)`

## 2. Types

Zena is strongly typed. All expressions have a type determined at compile time.

### Soundness

Zena features a **sound type system**. This means that the type checker
guarantees that a program that compiles successfully will not exhibit type
errors at runtime. For example, if a variable is typed as `String`, it is
guaranteed to always hold a string value at runtime.

This soundness is enforced by the underlying WASM-GC architecture. Zena does not
support "unsafe" blocks or unchecked type assertions that could violate memory
safety.

### Primitive Types

- **`i32`**: 32-bit signed integer. This is the default type for integer
  literals. Operations like division and comparison use signed semantics.
- **`i64`**: 64-bit signed integer. Used for large numbers. Constructed via
  casting (e.g., `100 as i64`).
- **`u32`**: 32-bit unsigned integer. Operations like division, modulo, and
  comparison use unsigned semantics. `i32` and `u32` cannot be mixed in
  operations without explicit casting using `as`.
- **`u64`**: 64-bit unsigned integer, with the same unsigned semantics.
- **`u8`, `u16`, `i8`, `i16`**: narrow integers, for describing exact storage
  widths — byte buffers, packed records, and WIT interop. They are storage
  types rather than arithmetic types: an operand promotes to its 32-bit
  counterpart (`u8`/`u16` to `u32`, `i8`/`i16` to `i32`) before any operation,
  so a narrow type never survives arithmetic and storing a result back needs
  an explicit `as`. See
  [arithmetic-conversions.md](design/arithmetic-conversions.md).
- **`f32`**: 32-bit floating-point number. This is the default type for
  floating-point literals.
- **`f64`**: 64-bit floating-point number. Constructed via casting (e.g., `1.0
as f64`).
- **`boolean`**: Boolean value (`true` or `false`).
- **`String`**: UTF-8 string.
- **`anyref`**: The top type for all reference types. It can hold any object,
  array, String, function, or `null`. It cannot hold unboxed primitives (`i32`,
  `f32`, `boolean`).
- **`never`**: The bottom type. It represents a value that never occurs (e.g.,
  the result of `throw` or a function that never returns). `never` is a subtype
  of every type.
- **`ByteArray`**: A mutable packed array of bytes — a name for `array<u8>`,
  not a distinct type. Elements read as `u8` and the storage is one byte per
  element. Low-level, used mainly for strings and binary data;
  `FixedArray<u8>` is the same storage with the full sequence API.

### The `anyref` Type

`anyref` is the top type for references: any value with a heap
representation — class instances, strings, arrays, records, tuples,
functions, and `null` — can be assigned to it. Primitives (`i32`,
`f64`, `boolean`, …) cannot: there is no implicit boxing in Zena. To
put a primitive behind an `anyref`, box it explicitly with the
ordinary `Box<T>` class from `zena:box`.

- **Safety**: You cannot perform operations on an `anyref` value
  directly. Test it with `is` and cast it back with `as`.
- **No auto-boxing**: allocation never happens implicitly. `Box<T>`
  construction is visible in the source.

```zena
import { Box } from 'zena:box';

let y: anyref = "hello";           // Reference type (String)
let x: anyref = new Box<i32>(42);  // Explicit box for a primitive
// let z: anyref = 42;             // Error: no implicit boxing

let s = y as String;               // Cast to String
let n = (x as Box<i32>).value;     // Unwrap the box explicitly
```

## 2.1 Enums

Enums allow you to define a set of named constants. Zena enums are nominal types
that wrap a union of literal values.

### Syntax

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

### Semantics

An enum declaration is conceptually equivalent to defining:

1.  A **Distinct Type** named `Color` (e.g. `distinct type Color = 0 | 1 | 2`).
2.  A **Global Constant** named `Color` containing the members as properties
    (e.g. `const Color = { Red: 0 as Color, ... }`).

```zena
let c: Color = Color.Red;
```

### Backing Types

Enums can be backed by integers (`i32`) or strings.

- **Integer Enums**: If no initializer is provided, values start at 0 and
  increment by 1.
  ```zena
  enum Status {
    Ok = 200,
    NotFound = 404
  }
  ```
- **String Enums**: Members are initialized with string literals.
  ```zena
  enum Direction {
    Up = "UP",
    Down = "DOWN"
  }
  ```

### Type Safety

Enums are **distinct types**, meaning they are not assignable to or from their
underlying primitive types without an explicit cast.

```zena
let c: Color = Color.Red;

// Error: Type 'i32' is not assignable to type 'Color'.
// let x: Color = 0;

// Error: Type 'Color' is not assignable to type 'i32'.
// let y: i32 = c;

// Explicit casting is allowed
let z: i32 = c as i32;
```

### Type Inference

Local variable types are inferred from their initializer expression.

```zena
let x = 10; // Inferred as i32
let s = 'hello'; // Inferred as String
```

#### Contextual Typing for Numeric Literals

Numeric literals infer their type from context in **comparison** and
**arithmetic** expressions. This is not implicit coercion—the literal is
statically allocated with the correct type from the start.

```zena
let x = 100 as i64;
if (x > 0) { ... }      // 0 is inferred as i64
if (0 < x) { ... }      // Also works: 0 is inferred from x
let y = x + 50;         // 50 is inferred as i64
let z = 50 + x;         // Also works: 50 is inferred from x
```

The inference is **bidirectional**: whichever operand is a literal gets its type
from the non-literal operand. When both operands are literals, they default to
`i32` (or `f32` for decimals).

**Variable Declarations**: Contextual typing applies here too — an annotation
on a declaration supplies the literal's type:

```zena
let a: i64 = 1;         // OK: the literal is typed i64
let b: u8 = 255;        // OK
let c: u8 = 256;        // Error: Integer literal 256 is out of range for type 'u8'
```

For the types whose range the compiler checks — the narrow types (`u8`, `u16`,
`i8`, `i16`) and the unsigned types (`u32`, `u64`) — a literal that cannot be
represented is rejected. `i32` and `i64` do not currently range-check their
literals.

A negated literal is measured as a whole, so `let low: i8 = -128;` is accepted
even though `128` alone would not fit.

> Earlier versions of this document stated that contextual typing did _not_
> apply to annotated declarations and that `let a: i64 = 1;` was an error.
> That has never matched the compiler's behaviour; the rule above is what
> ships.

### Type Casting

Zena enforces strict type safety and does not support implicit type coercion.

Explicit type casts (e.g., using an `as` operator) are **checked casts**. This
means the validity of the cast is verified at runtime. If the value is not of
the target type, a runtime error (trap) is raised. This ensures that the type
system remains sound even when downcasting.

**Numeric Conversions**: Conversions between numeric types (e.g., `i32` to
`i64`, `f32` to `i32`) generally must be explicit. These casts compile to
specific WASM conversion instructions (e.g., `i64.extend_i32_s`,
`i32.trunc_f32_s`).

- `i32` <-> `i64` (Sign-extend / Wrap)
- `i32` <-> `f32` (Convert / Truncate)
- `i64` <-> `f64` (Convert / Truncate)
- `i32` <-> `u32` (Reinterpret bits - zero cost)
- `i32`/`u32` -> `u8`, `u16` (Truncate to the low bits, zero-extended)
- `i32`/`u32` -> `i8`, `i16` (Truncate to the low bits, sign-extended, so
  `200 as i8` is `-56`)

**Implicit Conversions**: Zena supports implicit conversion **only** between
`i32` and `f32` in binary arithmetic operations.

- `i32` + `f32` -> `f32` (The `i32` is promoted to `f32`)
- `f32` + `i32` -> `f32`

All other mixed arithmetic (e.g., `i32` + `i64`, `f32` + `f64`) requires
explicit casting.

However, if the source type and the target type are identical (e.g. casting a
value to its own type, or casting between a distinct type and its underlying
type), the cast is **elided** at runtime. In these cases, the cast serves purely
as a compile-time assertion and incurs no runtime overhead.

The compiler can optionally warn you about unnecessary casts (casting an expression
to a type it already has) by enabling the `--warn-unnecessary-casts` CLI flag.

```zena
distinct type ID = i32;
let id = 1 as ID; // Checked at compile time, elided at runtime
```

### Type Aliases

Type aliases create a new name for a type. They are defined using the `type`
keyword.

```zena
type ID = String;
type Point = {x: i32; y: i32};
type Callback = (result: String) => void;
```

Type aliases can be generic:

```zena
type Box<T> = {value: T};
type Result<T> = {success: boolean; data: T};
```

Generic type parameters can be constrained using the `extends` keyword:

```zena
class Base {}
class Derived extends Base {}

type Container<T extends Base> = {value: T};
let c: Container<Derived> = {value: new Derived()};
```

Type parameter constraints can reference other type parameters:

```zena
type Wrapper<T extends Box<V>, V> = {item: T; inner: V};
```

### Distinct Types

Distinct types create a new type that is structurally identical to an existing
type but treated as a unique type by the type checker. This is useful for
creating type-safe identifiers or units of measure.

```zena
distinct type Meters = i32;
distinct type Seconds = i32;

let m: Meters = 10 as Meters;
let s: Seconds = 20 as Seconds;

// let x = m + s; // Error: Type mismatch
```

Distinct types are erased at runtime, so they have no performance overhead.
Casting between a distinct type and its underlying type is a zero-cost
operation.

### Opaque Types

An **opaque type** is a distinct type that cannot be forged. Anyone can write
`10 as Meters`, so a `distinct type` documents intent but does not enforce it.
An opaque type additionally restricts casts _to_ it to the file that declares
it, which makes the declaring file the only source of values.

```zena
// tokens.zena
export opaque type Token = i32;

// The only way to get a Token — the checks live here and cannot be bypassed.
export let mint = (raw: i32): Token => {
  if (raw <= 0) { throw new Error('token must be positive'); }
  return raw as Token;
};

export let value = (t: Token): i32 => t as i32;
```

```zena
// main.zena
import { Token, mint, value } from './tokens.zena';

let forged = 0 as Token; // Error: Cannot cast to opaque type 'Token'.
let real = mint(7);      // OK
let raw = real as i32;   // OK — see "Casting out", below
```

`opaque` implies `distinct`: an opaque type is not assignable to or from its
underlying type, and it is erased at runtime exactly like a distinct type, so
the guarantee costs nothing at runtime.

#### What counts as forging

The restriction is on casts that _manufacture_ a value, not on every mention of
the type in a cast target. A cast is allowed when the source and target types
already overlap — that is, when either is assignable to the other — because
such a cast cannot produce a value that did not already exist:

```zena
let t: Token = mint(1);
let same = t as Token;                       // OK — redundant, forges nothing

let unwrap = (t: Token | null): Token =>
  t as Token;                                // OK — narrowing, not forging
```

Narrowing a nullable opaque value is ordinary code at every call site, so it
stays legal outside the declaring file.

Because distinct types are erased, `Array<i32>` and `Array<Token>` share a
representation, and a cast through a type argument forges just as effectively
as a direct one. Opacity is therefore checked at every position of the cast
target — element types, union members, record fields, function parameters and
return types, and type arguments:

```zena
let ints = [1, 2, 3];
let forged = ints as Array<Token>; // Error: Cannot cast to opaque type 'Token'.
```

Naming the type through another alias does not help, since an alias's target is
checked too:

```zena
distinct type Tokens = Array<Token>;
let forged = ints as Tokens; // Error: Cannot cast to opaque type 'Token'.
```

#### Casting out

Casting _out_ of an opaque type is allowed anywhere:

```zena
let raw: i32 = real as i32; // OK
```

The guarantee an opaque type provides is that every value of it came from the
declaring file, so that file's invariants hold. Reading the underlying value
does not violate that. If you also want to hide the representation, use a
`class` with private fields instead — that is a different tool for a different
job.

#### Casts through type parameters

A generic function's type parameter is not a loophole. Because generics are
monomorphized and distinct types are erased, `x as T` with `T = Token` would
compile to `i32 as Token` and then to nothing at all — checked neither at
compile time (the checker only ever sees `T`) nor at run time. So a cast to a
type parameter is only accepted when something already says the value could be
one:

```zena
let launder = <T>(x: i32): T => x as T;      // Error: 'T' is unconstrained
let identity = <T>(x: T): T => x as T;       // OK — redundant
let unwrap = <T>(x: T | null): T => x as T;  // OK — narrowing
let pick = <T extends Animal>(a: Animal): T => a as T; // OK — downcast in bound
```

The same applies when a type parameter appears _inside_ the target, since
minting a container of them is no better than minting one:

```zena
let launderAll = <T>(xs: Array<i32>): Array<T> => xs as Array<T>; // Error
let relabel = <T>(xs: Array<T>): Sequence<T> => xs as Sequence<T>; // OK
```

The difference is whether the source already supplies the type arguments. The
second cast re-labels a container whose elements are already `T`, so it mints
nothing; the first would produce a `T` for every element.

### Function Types

Function types describe the signature of a function. They are written using
arrow syntax with **named parameters**. Parameter names are required to
disambiguate function types from tuple types (since both use parentheses).

```zena
type BinaryOp = (a: i32, b: i32) => i32;
type Callback = () => void;

let add: BinaryOp = (a, b) => a + b;
```

Note: `(i32, i32)` is always a **tuple type**, never a function type.
Use `(a: i32, b: i32) => i32` for function types.

### Union Types

Union types describe a value that can be one of several types. They are written
using the `|` operator.

```zena
let x: String | null = null;
x = 'hello';
```

#### Constraints

Union types in Zena are restricted to **Reference Types**. You cannot create a
union containing a value primitive (`i32`, `f32`, `boolean`).

- **Valid**: `String | null`, `MyClass | MyInterface`, `array<i32> | null`. -
  **Invalid**: `i32 | null`, `boolean | String`.

This restriction exists because value primitives in WASM have a different memory
representation (stack/value) than reference types (heap/pointer). Mixing them in
a single variable would require implicit boxing or a tagged union
representation, which Zena avoids for performance and simplicity.

To use a primitive in a union (e.g., for a nullable integer), you must wrap it
in a `Box<T>`.

```zena
import {Box} from 'zena';

let maybeNumber: Box<i32> | null = new Box(42);
```

**Note**: This is distinct from the "Indistinguishable Types" limitation (see
[Distinguishable Types & Erasure](#distinguishable-types--erasure)). Primitives
_are_ distinguishable from references, but they are incompatible in storage
layout.

#### Type Narrowing

Zena supports **control-flow-based type narrowing** for union types. When you
check whether a variable is or isn't `null`, or use the `is` operator, the type
system automatically narrows the variable's type within the respective branches.

##### Null Checks

```zena
class Node {
  value: i32;
  next: Node | null;

  new(value: i32) {
    this.value = value;
    this.next = null;
  }
}

let process = (node: Node | null): void => {
  if (node !== null) {
    // Inside this block, `node` is narrowed to `Node`
    let v = node.value;  // OK: `node` is known to be non-null
    let next = node.next;
  } else {
    // Inside this block, `node` is narrowed to `null`
    // node.value would be an error here
  }
  // After the if, `node` is back to `Node | null`
};
```

**Supported null-check patterns:**

- `x !== null` / `x != null`: Narrows `x` to non-null in the true branch, to
  `null` in the else branch.
- `null !== x` / `null != x`: Same as above.
- `x === null` / `x == null`: Narrows `x` to `null` in the true branch, to
  non-null in the else branch.
- `null === x` / `null == x`: Same as above.

##### Type Checks with `is`

The `is` operator narrows the type to the checked type in the true branch, and
removes that type in the else branch (for unions):

```zena
class Cat {
  new() {}
  meow(): String { return "meow"; }
}

class Dog {
  new() {}
  bark(): String { return "woof"; }
}

let speak = (pet: Cat | Dog): String => {
  if (pet is Cat) {
    // pet is narrowed to Cat
    return pet.meow();
  } else {
    // pet is narrowed to Dog (Cat removed from union)
    return pet.bark();
  }
};
```

Type narrowing is scoped to the block where the narrowing applies. Once you exit
the block, the original type is restored.

##### Field and Element Narrowing

Type narrowing also works for member expressions when the path is **immutable**:

- **Immutable class fields** (declared with `let`): Safe to narrow because the
  field cannot be modified between the check and use.
- **Record fields**: Always safe to narrow because records are immutable.
- **Tuple elements**: Always safe to narrow because tuples are immutable.

```zena
// Class with immutable field
class Wrapper {
  let inner: Container | null;
  new() : inner = null { }
}

let process = (w: Wrapper): i32 => {
  if (w.inner !== null) {
    return w.inner.value;  // w.inner narrowed to Container
  }
  return 0;
};

// Record field
let processRecord = (r: {inner: Container | null}): i32 => {
  if (r.inner !== null) {
    return r.inner.value;  // r.inner narrowed to Container
  }
  return 0;
};

// Tuple element
let processTuple = (t: (Container | null, i32)): i32 => {
  if (t[0] !== null) {
    return t[0].value;  // t[0] narrowed to Container
  }
  return 0;
};
```

**Mutable fields** (declared with `var`) cannot be narrowed because another
reference could modify the field between the null check and use:

```zena
class MutableWrapper {
  var inner: Container | null;  // Mutable field
  new() { this.inner = null; }
}

let process = (w: MutableWrapper): i32 => {
  if (w.inner !== null) {
    // ❌ Error: Cannot narrow mutable field
    // Another reference could set w.inner = null here
    return w.inner.value;
  }
  return 0;
};
```

### Literal Types

Zena supports **literal types** for strings, numbers, and booleans. A literal
type represents a single, specific value rather than a general type. Literal
types are especially useful in union types to create enumerations of specific
values.

```zena
// String literal types
type Mode = 'replace' | 'append' | 'insert';
let mode: Mode = 'replace';

// Number literal types
type Level = 1 | 2 | 3;
let level: Level = 2;

// Boolean literal types
let t: true = true;    // Type is exactly `true`
let f: false = false;  // Type is exactly `false`
type Flag = true | false;  // Equivalent to boolean
```

Literal types are checked at compile time and allow precise type constraints:

```zena
let setMode = (mode: 'read' | 'write') => {
  // mode is guaranteed to be exactly 'read' or 'write'
};

setMode('read');    // OK
setMode('append');  // Error: Type '"append"' is not assignable to type '"read" | "write"'
```

#### Type Inference and Widening

The type of a literal expression depends on whether the binding is mutable:

- **Immutable bindings (`let`)**: Literal types are preserved.
- **Mutable bindings (`var`)**: Literal types are widened to their base types.

```zena
let x = true;   // x has type `true` (literal type)
var y = true;   // y has type `boolean` (widened)

x = false;      // Error: Cannot assign `false` to `true`
y = false;      // OK: `boolean` allows both values
```

This behavior is intentional: mutable variables need a wider type to allow
reassignment. If you want a mutable variable with a literal type, use an
explicit type annotation:

```zena
var z: true = true;  // z has type `true`, but this limits assignments
z = false;           // Error: Cannot assign `false` to `true`
```

#### Boolean Literal Types in Generic Functions

When a generic function receives arguments with different boolean literal types,
the type parameter is widened to `boolean`:

```zena
@intrinsic('eq')
declare function equals<T>(a: T, b: T): boolean;

equals(true, true);   // T = true
equals(true, false);  // T = boolean (widened from conflicting true and false)
```

**Key points:**

- Literal types are **singleton types** - they represent exactly one value.
- Unlike regular primitive types, literal types **can be used in unions**
  because they are distinguishable at runtime.
- A literal value is assignable to its literal type and to the corresponding
  base type (e.g., `'hello'` is assignable to both `'hello'` and `String`).
- `let` preserves literal types; `var` widens them to base types (unless
  explicitly annotated).
- Literal types enable precise API contracts and exhaustive pattern matching.

## 3. Variables

Variables are declared using `let` or `var`.

- **`let`**: Declares a block-scoped immutable binding.
- **`var`**: Declares a block-scoped mutable binding.

> **Note for TypeScript/JavaScript developers**: Zena does not have the `const`
> keyword. Use `let` for immutable bindings. Keywords in Zena are case-sensitive
> and must be lowercase.

### Syntax

```zena
let name = expression;
var name = expression;
```

### Scoping

Variables declared with `let` and `var` are block-scoped. Redeclaring a variable
in the same scope is a compile-time error.

### Compile-Time Known Values

Variables declared with `let` and initialized with a literal value are
considered **compile-time known**. This enables features that require
statically-known values, such as tuple indexing:

```zena
let t = (1, "hello", true);

let idx = 0;          // let with literal initializer
let first = t[idx];   // ✅ OK - idx is compile-time known

var i = 0;
let x = t[i];         // ❌ Error - var is not compile-time known
```

This distinction also applies to type narrowing: `let` indices allow narrowing
to be tracked through tuple element access.

## 4. Functions

Zena has two ways to write a function: **arrow functions**, which are
expressions and can close over their surrounding scope, and **`function`
declarations**, which are top-level statements and cannot.

### Syntax

```zena
// Arrow function (an expression)
(param1: Type, param2: Type) => expression;

// Function declaration (a top-level statement)
function name(param1: Type, param2: Type): Ret { ... }
```

### Parameters

Function parameters require type annotations when the type cannot be inferred.

```zena
let add = (a: i32, b: i32) => a + b;
```

#### Contextual Typing for Closure Parameters

When a closure is passed as an argument to a function, parameter types can be
omitted if they can be inferred from the expected function type:

```zena
let numbers = [1, 2, 3, 4];

// Parameter type inferred from FixedArray<i32>.map signature
let doubled = numbers.map((x) => x * 2);

// Multiple parameters can be inferred
let fold = (f: (acc: i32, x: i32) => i32, init: i32, arr: FixedArray<i32>) => {
  var result = init;
  for (let x in arr) { result = f(result, x); }
  return result;
};
let sum = fold((acc, x) => acc + x, 0, numbers);
```

This works because the compiler knows the expected function type before checking
the closure. The expected parameter types flow "down" into the closure,
eliminating the need for explicit annotations.

**When contextual typing is not available**, parameter types must be explicit:

```zena
// Error: no contextual type available
let mystery = (x) => x * 2;

// OK: explicit type annotation
let double = (x: i32) => x * 2;
```

Explicit type annotations always take precedence over contextual types.

### Return Type

The return type is inferred from the body expression. It can also be explicitly
annotated.

```zena
let add = (a: i32, b: i32): i32 => a + b;
```

### Function Body

Function bodies can be a single expression or a block statement.

```zena
// Expression body
let add = (a: i32, b: i32) => a + b;

// Block body
let add = (a: i32, b: i32) => {
  return a + b;
};
```

### Function Declarations

A `function` declaration binds a name to a function at the top level of a
module. It is a statement, not an expression, so its body must be a block.

```zena
function add(a: i32, b: i32): i32 {
  return a + b;
}

export function main(): i32 {
  return add(1, 2);
}
```

#### The difference from arrow functions: no closures

This is the one semantic difference, and the reason the form exists: **a
`function` declaration can never be a closure.** Its body can reach only its
own parameters, its own locals, and module-level bindings (globals, imports,
classes). There is nothing else in scope, because a `function` may only appear
at the top level of a module — writing one inside another function or a block
is an error:

```zena
let makeCounter = (start: i32) => {
  function bad(): i32 {   // Error: 'function' declarations may only appear
    return start;         //        at the top level of a module.
  }
  return bad;
};
```

Use an arrow function where you need to capture:

```zena
let makeCounter = (start: i32) => {
  let next = (): i32 => start + 1;   // fine: arrows capture
  return next;
};
```

Because a `function` provably has no captured environment, the compiler never
allocates a context object for it: a call compiles to a direct call, and there
is nothing to heap-allocate at the point the function "comes into existence."
(Referring to one as a _value_ still produces a function value — see
[As a value](#as-a-value) — because that is what every function value in Zena
is.) An arrow bound to a top-level `let` that happens not to capture anything
compiles the same way today, but only `function` _guarantees_ it: a later edit
cannot silently turn it into a closure.

#### Hoisting, recursion, and mutual recursion

Declarations are hoisted, so order in the file does not matter. A declaration
can be referenced before it appears, can call itself, and can be mutually
recursive with its siblings:

```zena
export function main(): i32 {
  return isEven(10);        // forward reference
}

function isEven(n: i32): i32 {
  if (n == 0) { return 1; }
  return isOdd(n - 1);      // mutual recursion
}

function isOdd(n: i32): i32 {
  if (n == 0) { return 0; }
  return isEven(n - 1);
}
```

As with arrow functions bound to a `let`, a forward reference needs a
resolvable signature: annotate the return type when a function is used before
its declaration or participates in a recursive cycle.

#### As a value

A declared function is an ordinary function value and can be passed, stored,
and returned:

```zena
function double(x: i32): i32 { return x * 2; }

function apply(f: (x: i32) => i32, v: i32): i32 { return f(v); }

let alias = double;
let result = apply(double, 21);   // 42
```

#### Generics, generators, and async

`function` declarations take type parameters, and the `gen` and `async`
modifiers work exactly as they do on arrows:

```zena
function identity<T>(value: T): T {
  return value;
}

gen function counter(n: i32): Iterator<i32> {
  var i = 0;
  while (i < n) {
    yield i;
    i += 1;
  }
}

async function load(url: String): Future<String> {
  return await fetch(url);
}
```

`async gen function` is rejected, matching `async gen` arrows.

#### Exporting

Prefix with `export`, as with any other declaration:

```zena
export function helper(): i32 { return 1; }
export gen function items(): Iterator<i32> { yield 1; }
export async function load(): Future<i32> { return 1; }
```

### Closures

Arrow functions in Zena are closures. They can capture variables from their
surrounding scope. (`function` declarations cannot — see
[Function Declarations](#function-declarations) above.) Captured variables are stored in a heap-allocated context,
ensuring they remain available even after the outer scope has returned.

```zena
let makeAdder = (x: i32) => {
  return (y: i32) => x + y;
};

let add5 = makeAdder(5);
let result = add5(10); // 15
```

### Generic Functions

Functions can be generic by specifying type parameters before the parameter
list:

```zena
let identity = <T>(x: T): T => x;

let num = identity<i32>(42);
let str = identity<String>('hello');
```

Generic type parameters can be constrained:

```zena
class Printable {
  toString(): String {
    return 'object';
  }
}

let print = <T extends Printable>(x: T): void => {
  // Can call methods from Printable constraint
};
```

Type arguments are often inferred:

```zena
let identity = <T>(x: T): T => x;
let result = identity(42); // T inferred as i32
```

### Argument Adaptation

Zena supports passing functions with fewer arguments than expected by the
receiver. The compiler automatically generates an adapter to bridge the
difference. This applies to function arguments, variable assignments, and union
type matching.

```zena
// Function expecting a callback with 3 arguments
let map = (fn: (item: i32, index: i32, array: MyArray) => i32) => { ... };

// You can pass a callback that uses fewer arguments
map((item) => item * 2); // Ignores index and array
map((item, index) => item + index); // Ignores array

// Assignment to Union Type
type Handler = (a: i32, b: i32) => void;

// Target is Union: Handler | String
// Provided: (a: i32) => void
// Result: Adapts to Handler
let h: Handler | String = (a: i32) => {};

```

This adaptation incurs a small performance overhead (allocation of a wrapper
closure) and is only applied when the arity mismatch is detected at compile
time.

### Optional Parameters

Function parameters can be marked as optional using `?`. Optional parameters
must come after required parameters.

When a parameter is optional and has no default value, its type becomes a union
with `null` (e.g., `T | null`). Because unions cannot contain primitive types,
**optional primitive parameters must have a default value** or be wrapped in
`Box<T>`.

```zena
// ✅ Valid: Reference type (String | null)
let greet = (name?: String) => { ... };

// ✅ Valid: Primitive with default value (type is i32)
let increment = (amount: i32 = 1) => { ... };

// ✅ Valid: Boxed primitive (Box<i32> | null)
let process = (val?: Box<i32>) => { ... };

// ❌ Invalid: Primitive without default (would be i32 | null)
// let invalid = (amount?: i32) => { ... };
```

```zena
let greet = (name: String, greeting?: String) => {
  // greeting is inferred as String | null
  if (greeting == null) {
    return `Hello, ${name}`;
  }
  return `${greeting}, ${name}`;
};

greet('Alice'); // "Hello, Alice"
greet('Bob', 'Hi'); // "Hi, Bob"
```

### Default Parameter Values

Parameters can have default values that are used when the caller omits the argument.

```zena
let increment = (x: i32, amount: i32 = 1) => x + amount;

increment(10); // 11
increment(10, 5); // 15
```

**Key semantics:**

1. **Compile-time, argument-count based**: Default values are triggered purely
   based on whether the argument is provided at the call site. This is
   determined at compile time by comparing the number of arguments to the number
   of parameters. Unlike JavaScript, there is no runtime sentinel value (like
   `undefined`) that triggers the default.

2. **Fresh evaluation**: Default expressions are evaluated fresh at each call
   site. Unlike Python, default values are not shared or cached between calls.

   ```zena
   import {Array} from 'zena:array';

   class Processor {
     // A new Array is created for each call that uses the default
     process(items: Array<i32> = new Array<i32>()): i32 {
       let len = items.length;
       items.push(1);
       return len;
     }
   }

   let p = new Processor();
   p.process(); // 0 (new empty array created)
   p.process(); // 0 (another new empty array, not the same one)
   ```

3. **No boxing for primitives**: When a primitive default (like `i32 = 10`) is
   used, the value is passed directly without boxing. No runtime overhead is
   incurred.

4. **`null` does not trigger defaults**: Explicitly passing `null` to a nullable
   parameter does not trigger the default value—only omitting the argument
   entirely does.

   ```zena
   let greet = (name: String | null = 'World') => `Hello, ${name}`;

   greet();       // "Hello, World" - default used
   greet('Alice'); // "Hello, Alice"
   greet(null);   // "Hello, null" - null passed, default NOT used
   ```

5. **Access to `this` in methods**: Default expressions in methods can reference
   `this` and class members, including private fields.

   ```zena
   class Reader {
     #currentPos: i32;

     new(pos: i32) {
       this.#currentPos = pos;
     }

     // Default uses this.#currentPos
     read(start: i32 = this.#currentPos): i32 {
       return start;
     }
   }

   let reader = new Reader(42);
   reader.read();    // 42 (uses this.#currentPos as default)
   reader.read(10);  // 10 (explicit argument)
   ```

When a default value is provided, the parameter type in the function body is the non-nullable type (unless the default value itself is null).

### Destructured Parameters

Function parameters can use destructuring patterns to extract fields from
records, tuples, or class instances directly in the parameter list.

#### Record Destructured Parameters

The **combined syntax** declares field names and types together, avoiding
duplication:

```zena
let getX = ({x: i32, y: i32}) => x;
getX({x: 10, y: 20}); // 10

// With renaming
let getFirst = ({x as a: i32, y as b: i32}) => a;

// With field default
let getX = ({x: i32 = 0, y: i32}) => x;
```

The **separate syntax** uses a pattern followed by an explicit type annotation:

```zena
let getX = ({x, y}: {x: i32, y: i32}) => x;

// With renaming (separate syntax)
let getFirst = ({x as a, y as b}: {x: i32, y: i32}) => a;
```

#### Contextual Typing

When the expected parameter type is known from context, the type annotation can
be omitted entirely:

```zena
let apply = (f: (p: {x: i32, y: i32}) => i32) => f({x: 1, y: 2});
apply(({x, y}) => x + y); // 3 — types inferred from f's parameter type
```

#### Tuple Destructured Parameters

```zena
let sum = ((a, b): (i32, i32)) => a + b;
sum((3, 4)); // 7
```

#### Multiple Destructured Parameters

Destructured and normal parameters can be mixed freely:

```zena
let combine = (scale: i32, {x: i32, y: i32}) => x * scale + y * scale;
combine(2, {x: 3, y: 4}); // 14
```

#### Destructured Parameters with Defaults

When a destructured parameter has a default value, the default is used if the
argument is omitted. The default value is then destructured:

```zena
let origin = ({x: i32, y: i32} = {x: 0, y: 0}) => x + y;
origin();             // 0 (default used)
origin({x: 3, y: 4}); // 7 (provided value used)
```

#### Class Method Destructured Parameters

Destructured parameters work in class methods as well:

```zena
class Calculator {
  offset: i32;
  new(offset: i32) { this.offset = offset; }
  add({x: i32, y: i32}): i32 {
    return this.offset + x + y;
  }
}
```

### Calling Union Types

Zena supports calling a function that is typed as a Union of function types,
even if those functions have different arities. The compiler generates a runtime
dispatch that checks the actual type of the function and calls it with the
appropriate number of arguments. Extra arguments are ignored if the runtime
function expects fewer.

```zena
type Fn1 = (a: i32) => i32;
type Fn2 = (a: i32, b: i32) => i32;
type AnyFn = Fn1 | Fn2;

let f1: AnyFn = (a) => a;
let f2: AnyFn = (a, b) => a + b;

// Call with maximum arguments
// If f1 is the runtime value, it receives (10). '20' is ignored.
// If f2 is the runtime value, it receives (10, 20).
f1(10, 20); // Returns 10
f2(10, 20); // Returns 30
```

### Function Overloading

Zena supports function overloading for declared external functions. This allows
you to define multiple signatures for the same function name, provided they have
different parameter lists.

```zena
declare function print(val: i32): void;
declare function print(val: f32): void;

print(42); // Calls print(i32)
print(3.14); // Calls print(f32)
```

Overload resolution is performed based on the argument types at the call site.

### Generator Functions

> **Status:** implemented in the self-hosted compiler only (the
> bootstrap compiler never learns generators). See
> `docs/design/generators.md`.

A generator is a function expression with the `gen` modifier; `yield`
is a statement valid only in the immediately enclosing `gen` body.
Calling a generator produces an `Iterator<T>` lazily (none of the body
runs until the first `next()`), and the declared return type is that
`Iterator<T>` — annotations always name the call expression's type.
The yield type is its argument. `Iterator` resolves from the prelude
without an import:

```zena
let range = gen (start: i32, end: i32): Iterator<i32> => {
  var i = start;
  while (i < end) {
    yield i;
    i += 1;
  }
};

for (let i in range(0, 5)) {
  console.log(i.toString());
}
```

`gen` also applies to methods (modifier position, like `static`), where
the return type annotation is required:

```zena
class Tree {
  gen values(): Iterator<i32> {
    yield this.value;
  }
}
```

Rules:

- The declared return type must be `Iterator<T>`; each `yield e;`
  checks `e` against `T`.
- With no annotation, the yield type is inferred from the `yield`
  statements (the function still types as `Iterator<inferred>`); a
  generator that never yields needs an annotation.
- Generators require a block body (no expression bodies).
- Value returns are rejected; complete with bare `return;` or by
  falling off the end.
- `yield` inside `try`/`catch`/`finally` is rejected (v1 restriction).
- `yield` inside a non-`gen` closure nested in a generator is an error.

The keywords `gen`, `yield`, `async`, and `await` are reserved words in
the self-hosted compiler (`async`/`await` are reserved for future async
functions).

## 5. Expressions & Operators

### Literals

- **Numbers**: `123`, `0`, `-5`, `0x1A`, `0xFF` (Parsed as `i32` by default).
- **Strings**: `"text"` or `'text'`.
- **Template Literals**: `` `text ${expression}` `` (Backtick-delimited with
  interpolation).

### String Escape Sequences

String literals support the following escape sequences:

| Escape | Character       |
| ------ | --------------- |
| `\\`   | Backslash (`\`) |
| `\n`   | Newline         |
| `\r`   | Carriage return |
| `\t`   | Tab             |
| `\"`   | Double quote    |
| `\'`   | Single quote    |

```zena
let message = 'Hello\nWorld'; // Contains a newline
let path = 'C:\\Users\\file'; // Escaped backslashes
let quote = 'She said "Hi"'; // Escaped double quotes
let apostrophe = "it's"; // Escaped single quote
```

**Note**: Unicode escape sequences (e.g., `\uXXXX`) are not currently supported.
Since Zena source files are UTF-8, you can include Unicode characters directly
in the string.

### Strings

Strings are immutable sequences of characters.

- **Literals**: `'text'` or `"text"`.
- **Concatenation**: `+` operator.
- **Length**: `str.length` returns the length of the string.
- **Indexing**: Direct indexed access (`str[index]`) is **not supported**. Use
  iterators or methods like `charAt()` (planned) to access characters.

### Template Literals

Template literals are backtick-delimited strings that support embedded
expressions and preserve raw string content.

#### Basic Template Literals

```zena
let greeting = `Hello, World!`;
let multiline = `Line 1
Line 2`;
```

#### String Interpolation

Expressions can be embedded using `${}`:

```zena
let name = 'Alice';
let greeting = `Hello, ${name}!`; // "Hello, Alice!"

let a = 5;
let b = 10;
let sum = `${a} + ${b} = ${a + b}`; // "5 + 10 = 15"
```

#### Escape Sequences in Templates

Template literals support the same escape sequences as regular strings, plus:

| Escape   | Character                              |
| -------- | -------------------------------------- |
| `` \` `` | Backtick                               |
| `\$`     | Dollar sign (to prevent interpolation) |

```zena
let code = `Use \`backticks\` for templates`;
let price = `Cost: \$100`; // Prevents ${} interpolation
```

#### Tagged Template Literals

Tagged templates allow custom processing of template literals by preceding them
with a tag function:

```zena
let tag = (strings: Array<String>, values: Array<i32>): String => {
  // strings: array of string literals between expressions
  // values: array of evaluated expressions
  return strings[0];
};

let result = tag`Hello ${42} World`;
```

The tag function receives:

1. **strings**: An array of the literal string parts. This array has a `raw`
   property containing the original source strings (before escape processing).
2. **values**: An array of the interpolated expression values.

The strings array length is always `values.length + 1`.

**Note**: The strings array maintains identity across evaluations of the same
template expression, allowing it to be used as a cache key for expensive
one-time processing.

```zena
// Example: SQL query builder
let sql = (strings: Array<String>, values: Array<i32>): String => {
  // Build parameterized query from strings
  // Use values for parameters
  return strings[0];
};

let userId = 123;
let query = sql`SELECT * FROM users WHERE id = ${userId}`;
```

### Unary Operators

- `!` (Logical NOT) - Inverts a boolean value.
- `-` (Negation) - Negates a numeric value (`i32` or `f32`).

### Binary Operators

Supported arithmetic operators for numeric types (`i32`, `u32`, `f32`):

- `+` (Addition / String Concatenation / Custom via `operator +`)
- `-` (Subtraction)
- `*` (Multiplication)
- `/` (Division) - Always returns a floating-point value (`f32` or `f64`).
- `%` (Modulo - integer types only) - Signed for `i32`, unsigned for `u32`.

Classes can define custom behavior for `+` via `operator +`. See [Operator
Overloading](#operator-overloading).

Supported bitwise operators for integer types (`i32`, `u32`, `i64`, `u64`):

- `&` (Bitwise AND)
- `|` (Bitwise OR)
- `^` (Bitwise XOR)
- `<<` (Left Shift)
- `>>` (Right Shift) - Arithmetic shift (sign-extends for signed types,
  zero-fills for unsigned types)
- `>>>` (Unsigned Right Shift) - Always zero-fills (logical shift)

**Examples:**

```zena
// Bitwise operations
let mask = 0b1111 & 0b1010;  // 0b1010 (10)
let bits = 0b1100 | 0b0011;  // 0b1111 (15)
let flip = 0b1100 ^ 0b1010;  // 0b0110 (6)

// Shift operations
let doubled = 5 << 1;        // 10 (shift left by 1 = multiply by 2)
let halved = 10 >> 1;        // 5 (shift right by 1 = divide by 2)
let quadrupled = 3 << 2;     // 12 (shift left by 2 = multiply by 4)

// Signed vs unsigned right shift
let negative: i32 = -8;
let signExtended = negative >> 1;    // -4 (sign bit preserved)
let zeroFilled = negative >>> 1;     // 2147483644 (zero-filled)

// With unsigned types
let value: u32 = 16 as u32;
let shifted = value >> 2;    // 4 (always zero-fills for u32)
```

Operands must be of the same type, with the exception of mixing `i32` and `f32`.
**Mixing other numeric types (e.g., `i32` and `i64`) is not allowed**; you must
explicitly cast using `as`.

```zena
let a = 10;
let b = 20;
let c = a + b; // Valid
let s = 'Hello' + ' World'; // Valid (String Concatenation via operator +)
// let d = a + "string"; // Error: Type mismatch

// Unsigned example
let x: u32 = 10 as u32;
let y: u32 = 3 as u32;
let q = x / y;  // Result is 3.333... (f32)

// Mixing i32 and f32 is allowed (result is f32)
let i: i32 = 5;
let f: f32 = 2.5;
let sum = i + f; // OK, result is 7.5 (f32)

// Mixing i32 and i64 requires explicit cast
let big: i64 = 100 as i64;
// let res = i + big; // Error: Cannot mix i32 and i64
let res = (i as i64) + big; // OK
```

### Function Calls

Functions can be called using parentheses `()`.

```zena
let result = add(1, 2);
```

### Assignment

Mutable variables (declared with `var`) can be reassigned.

```zena
var x = 1;
x = 2;
```

#### Compound Assignment

Compound assignment operators combine a binary operation with assignment. They
read the current value, apply the operator with the right-hand side, and write
the result back.

- `+=` (Add and assign)
- `-=` (Subtract and assign)
- `*=` (Multiply and assign)
- `/=` (Divide and assign)
- `%=` (Modulo and assign)
- `??=` (Nullish assign — assign if `null`)

```zena
var x = 10;
x += 5;   // x is now 15
x -= 3;   // x is now 12
x *= 2;   // x is now 24
x /= 4;   // x is now 6
x %= 4;   // x is now 2
```

The nullish assignment operator `??=` assigns the right-hand side only when the
left-hand side is `null`. It short-circuits: the right side is not evaluated
when the left is non-null.

```zena
var name: String | null = null;
name ??= 'Anonymous';  // name is now 'Anonymous'

var value: String | null = 'hello';
value ??= 'default';   // value is still 'hello'
```

Compound assignment works with variables, class fields, and array indices:

```zena
class Counter {
  var count: i32 = 0;
  new() {}
  increment(n: i32): void { this.count += n; }
}

var arr = [10, 20, 30];
arr[1] += 5;  // arr[1] is now 25
```

Compound assignment also works with `operator +` overloading on classes.

### Grouping

Parentheses `( )` can be used to group expressions and control precedence.

```zena
let result = (1 + 2) * 3;
```

### Comparison Operators

- `==` (Equal) - Supports value equality for strings.
- `!=` (Not Equal) - Supports value equality for strings.
- `===` (Strict Equal) - Checks for reference equality, bypassing custom
  `operator ==`.
- `!==` (Strict Not Equal) - Checks for reference inequality, bypassing custom
  `operator ==`.
- `<` (Less Than) - Signed comparison for `i32`, unsigned for `u32`.
- `<=` (Less Than or Equal) - Signed comparison for `i32`, unsigned for `u32`.
- `>` (Greater Than) - Signed comparison for `i32`, unsigned for `u32`.
- `>=` (Greater Than or Equal) - Signed comparison for `i32`, unsigned for
  `u32`.

These operators return a boolean value. **Comparing `i32` and `u32` directly is
not allowed**; cast one to the other first.

### Logical Operators

- `&&` (Logical AND) - Short-circuiting AND. Returns `true` if both operands are
  `true`.
- `||` (Logical OR) - Short-circuiting OR. Returns `true` if at least one
  operand is `true`.

Operands must be of type `boolean`.

### Nullish Coalescing (`??`)

The nullish coalescing operator `??` returns its right-hand operand when the
left-hand operand is `null`, and the left-hand operand otherwise. It is a
short-circuiting operator: the right side is only evaluated if the left is
`null`.

```zena
let name: String | null = null;
let display = name ?? 'Anonymous';  // 'Anonymous'

let value: String | null = 'hello';
let result = value ?? 'default';    // 'hello'
```

`??` has the same precedence as `||`. Unlike JavaScript, Zena allows mixing
`??` with `||` and `&&` without parentheses.

### Optional Chaining (`?.`, `?[]`, `?()`)

Optional chaining operators allow safe access to properties, elements, and
methods on values that may be `null`. If the value before the operator is
`null`, the entire chain short-circuits and evaluates to `null`.

```zena
class User {
  name: String;
  new(name: String) { this.name = name; }
}

let user: User | null = null;

// Property access
let name = user?.name;       // null (not a runtime error)

// Index access
let items: Items | null = null;
let first = items?[0];       // null

// Method call
let callback: ((a: i32) => i32) | null = null;
let result = callback?(42);  // null
```

Optional chaining can be combined with nullish coalescing to provide defaults:

```zena
let display = user?.name ?? 'Anonymous';
```

The result type of an optional chain is `T | null`, where `T` is the type of
the accessed property, element, or call result.

**Primitive results require immediate coalescence.** When `T` is a primitive
(`i32`, `f64`, `boolean`, …), the union `T | null` has no runtime
representation — primitives are not references and are never boxed — so the
chain must appear directly as the left operand of `??`:

```zena
let p: Point | null = null;

let x = p?.x ?? 0;   // OK: the miss becomes the ?? arm; only i32 exists
let y = p?.x;        // error: optional access to a primitive requires
                     //        immediate coalescence
```

This guarantees `primitive | null` never flows into a variable, field,
parameter, or return value. Reference-typed results are unaffected.

### Operator Precedence

Operators are listed from highest to lowest precedence:

1. Unary (`!`, `-`)
2. Multiplicative (`*`, `/`, `%`)
3. Additive (`+`, `-`)
4. Shift (`<<`, `>>`, `>>>`)
5. Range (`..`)
6. Comparison (`<`, `<=`, `>`, `>=`)
7. Equality (`==`, `!=`, `===`, `!==`)
8. Bitwise AND (`&`)
9. Bitwise XOR (`^`)
10. Bitwise OR (`|`)
11. Logical AND (`&&`)
12. Logical OR / Nullish Coalescing (`||`, `??`)
13. Pipeline (`|>`)
14. Assignment (`=`, `+=`, `-=`, `*=`, `/=`, `%=`)

Operators at the same precedence level are left-associative (evaluated
left-to-right).

```zena
let x = 2 + 3 * 4;      // 2 + (3 * 4) = 14
let y = 8 << 1 + 1;     // 8 << (1 + 1) = 8 << 2 = 32
let z = 5 & 3 == 1;     // Type error: Cannot mix integer and boolean
let w = (5 & 3) == 1;   // OK: (5 & 3) == 1 -> 1 == 1 -> true
```

### Range Operators

Range operators create range objects that represent sequences of indices. They
are primarily used for array slicing and iteration. The range operator is `..`
(two dots).

Range types must be imported from `zena:range`:

```zena
import { BoundedRange, FromRange, ToRange, FullRange, Range } from 'zena:range';
```

#### Bounded Range: `a..b`

Creates a half-open range `[a, b)` that includes `a` but excludes `b`.

```zena
let r = 1..10;  // BoundedRange from 1 to 10 (exclusive)
// Represents indices: 1, 2, 3, 4, 5, 6, 7, 8, 9
```

#### From Range: `a..`

Creates a range from `a` to the end of a collection.

```zena
let r = 5..;  // FromRange starting at 5
// When used with an array, goes from index 5 to the end
```

#### To Range: `..b`

Creates a range from the beginning to `b` (exclusive).

```zena
let r = ..10;  // ToRange from 0 to 10 (exclusive)
// Represents indices: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9
```

#### Full Range: `..`

Creates a range representing all elements.

```zena
let r = ..;  // FullRange (all elements)
```

#### Range Type

The `Range` type is a union of all range types:

```zena
type Range = BoundedRange | FromRange | ToRange | FullRange;
```

**Note**: Range bounds must be valid array/loop indices (type `i32`). Ranges
with arithmetic expressions are evaluated at creation time:

```zena
let start = 5;
let end = 10;
let r = start..end;           // BoundedRange(5, 10)
let r2 = (x + 1)..(y * 2);    // Expressions evaluated before range creation
```

### Pipeline Operator

The pipeline operator `|>` enables fluent data transformation chains by passing
the result of one expression as input to the next. The piped value is accessed
via the placeholder `$`.

```zena
// Without pipeline - hard to read (inside-out)
let result = validate(transform(normalize(parse(data)), options), schema);

// With pipeline - read left-to-right
let result = data |> parse($) |> normalize($) |> transform($, options) |> validate($, schema);
```

#### Syntax

The left-hand side is evaluated first, and its result becomes available to the
right-hand side via `$`:

```zena
expression |> expression  // $ refers to the left expression's result
```

Pipelines can be chained:

```zena
a |> f($) |> g($) |> h($)  // ((a |> f($)) |> g($)) |> h($)
```

#### Placeholder (`$`)

The placeholder `$` refers to the piped value. It can be used multiple times in
the right-hand side:

```zena
// Use $ multiple times
10 |> $ + $  // 20

// With other arguments
data |> process($, config) |> validate($)
```

`$` is only valid inside the right-hand side of a pipeline expression. Using it
elsewhere is a compile-time error:

```zena
let x = $;  // Error: '$' can only be used inside a pipeline expression
```

#### With Tuple Indexing

When the piped value is an inline tuple (e.g., from a multi-return function),
use tuple indexing to access elements:

```zena
// getNames() returns (String, String)
person.getNames() |> formatFullName($[0], $[1])

// map.get() returns (V, bool)
scores.get(name) |> if ($[1]) processScore($[0]) else 0
```

#### Precedence

The pipeline operator has very low precedence, below assignment but above comma:

```zena
let result = data |> transform($) |> validate($);  // Works as expected
```

#### With Method Calls

Pipeline works naturally with method calls on the piped value:

```zena
text |> $.trim() |> $.toUpperCase() |> $.split(' ')
```

Though for pure method chaining, regular `.` syntax may be clearer:

```zena
text.trim().toUpperCase().split(' ')
```

Pipelines are most useful when mixing functions and methods, or when passing the
value as an argument to functions.

## 6. Control Flow

### Optional Semicolons

Semicolons are generally required to terminate statements. However, for
block-ended expressions (`if`, `match`, `try`) used as standalone statements,
the trailing semicolon is optional.

```zena
// Optional semicolon
if (x) { ... } else { ... }

match (x) {
  case 1: ...
}

try {
  ...
} catch {
  ...
}
```

**Note**: When these expressions are used as part of another statement (e.g.,
variable declaration, return statement), the semicolon is still required.

```zena
// Required semicolon
let x = if (cond) 1 else 2;
return match (x) { ... };
```

### Blocks

A block statement groups zero or more statements within curly braces `{}`.
Blocks introduce a new **lexical scope**. Variables declared within a block are
only accessible within that block and any nested blocks.

```zena
let outer = 1;
{
  let inner = 2;
  // outer and inner are visible
}
// inner is not visible here
```

### If Statement

Zena supports `if` and `else` for conditional execution.

```zena
if (condition) {
  // consequent
} else {
  // alternate
}
```

### If Expression

Like Rust, Zena's `if/else` can be used as an expression. Each block evaluates
to the value of its last expression. When used as an expression, the `else`
clause is required.

```zena
// Simple if expression
let x = if (condition) 1 else 2;

// With block bodies - the last expression is the value
let y = if (a > b) {
  let temp = a * 2;
  temp + 1
} else {
  b
};

// Chained else-if
let sign = if (n < 0) {
  -1
} else if (n == 0) {
  0
} else {
  1
};

// As function body
let max = (a: i32, b: i32) => if (a > b) a else b;
```

**Key differences from if statements:**

- When used as an expression, `else` is required
- Block bodies don't need semicolons after the final expression
- Both branches must produce compatible types

### While Statement

Zena supports `while` loops.

```zena
while (condition) {
  // body
}
```

### Let-Pattern Conditions

Both `if` and `while` statements support let-pattern conditions, which combine
pattern matching with control flow. The pattern variables are only in scope
inside the statement body.

```zena
// With if - execute body only if pattern matches
if (let (true, value) = maybeGetValue()) {
  // value is in scope here
  console.log(value);
}
// value is NOT in scope here

// With while - iterate while pattern matches
while (let (true, item) = iterator.next()) {
  // Process item
  console.log(item);
}
```

This is particularly useful for iterating over discriminated union iterators:

```zena
class Counter {
  value: i32;
  new() { this.value = 0; }

  next(): inline (true, i32) | inline (false, _) {
    this.value = this.value + 1;
    if (this.value <= 3) {
      return (true, this.value);
    }
    return (false, _);
  }
}

let counter = new Counter();
var sum = 0;
while (let (true, v) = counter.next()) {
  sum = sum + v;
}
// sum = 6 (1 + 2 + 3)
```

### For Statement

Zena supports C-style `for` loops. The loop variable must be declared with `var`
since it is mutable.

```zena
for (var i = 0; i < 10; i = i + 1) {
  // body
}
```

The `for` statement consists of three optional parts:

- **init**: A variable declaration or expression, executed once before the loop
  starts.
- **test**: A boolean expression evaluated before each iteration. If false, the
  loop exits.
- **update**: An expression executed after each iteration.

Any of these parts can be omitted:

```zena
// Infinite loop (test omitted)
for (;;) {
  // Use return or break to exit
}

// Init omitted
var i = 0;
for (; i < 10; i = i + 1) {
  // ...
}

// Update omitted (increment in body)
for (var i = 0; i < 10; ) {
  i = i + 1;
}
```

### For-In Statement

The `for-in` loop iterates over collections that implement the `Iterable<T>`
interface.

```zena
let arr = [10, 20, 30];
var sum = 0;
for (let x in arr) {
  sum = sum + x;
}
// sum == 60
```

The iterable expression must implement `Iterable<T>`:

```zena
// Works with FixedArray (implements Iterable)
let numbers = [1, 2, 3, 4, 5];
for (let n in numbers) {
  console.log(n);
}

// Works with any class implementing Iterable<T>
class Counter implements Iterable<i32> {
  #max: i32;

  new(max: i32) { this.#max = max; }

  iterator(): Iterator<i32> {
    return new CounterIterator(this.#max);
  }
}

let counter = new Counter(5);
for (let n in counter) {
  console.log(n);  // Prints 1, 2, 3, 4, 5
}
```

The loop variable is immutable (`let`) and scoped to the loop body. `break` and
`continue` work as expected:

```zena
let arr = [1, 2, 3, 4, 5];
var sum = 0;

for (let x in arr) {
  if (x == 3) {
    continue;  // Skip 3
  }
  if (x > 4) {
    break;  // Stop at 5
  }
  sum = sum + x;
}
// sum == 7 (1 + 2 + 4)
```

### Break and Continue Statements

The `break` statement exits the innermost enclosing loop immediately.

```zena
var i = 0;
while (true) {
  if (i >= 10) {
    break;  // Exit the loop
  }
  i = i + 1;
}
// i == 10
```

The `continue` statement skips the rest of the current iteration and proceeds to
the next iteration. In a `while` loop, this jumps to the condition check. In a
`for` loop, this executes the update expression first, then checks the
condition.

```zena
var sum = 0;
for (var i = 0; i < 10; i = i + 1) {
  if (i - ((i / 2) as i32) * 2 == 0) {
    continue;  // Skip even numbers
  }
  sum = sum + i;
}
// sum == 25 (1 + 3 + 5 + 7 + 9)
```

Both `break` and `continue` apply only to the innermost loop:

```zena
var count = 0;
var i = 0;
while (i < 3) {
  var j = 0;
  while (j < 5) {
    j = j + 1;
    if (j == 3) {
      break;  // Only exits inner loop
    }
    count = count + 1;
  }
  i = i + 1;
}
// count == 6 (2 iterations per outer loop × 3 outer loops)
```

### Match Expression

Zena supports pattern matching using the `match` expression.

```zena
let x = 1;
let result = match (x) {
  case 1: "one"
  case 2: "two"
  case _: "other"
};
```

#### Patterns

- **Literals**: Match exact values.

  ```zena
  case 1: ...
  case 'hello': ...
  case true: ...
  case null: ...
  ```

- **Bindings**: `let` (or `var`) binds the matched value to a new variable.

  ```zena
  case let x: x + 1
  ```

- **Type patterns**: A bare name matches instances of the class it names.

  ```zena
  case Circle: ... // matches any Circle
  ```

- **Wildcard**: `_` matches any value without binding.

  ```zena
  case _: ...
  ```

- **Class Patterns**: Match class instances and destructure fields.

  ```zena
  case let Point { x: 0, y }: ... // Matches Point with x=0, binds y
  ```

- **Record Patterns**: Match records and destructure fields.

  ```zena
  case let { a: 1, b }: ...
  ```

  Shorthand fields bind, exactly like `let { a, b } = record` destructuring: in
  `case { a: 1, b }` the `b` introduces a new variable holding the record's `b`
  field. Use `as` to bind a field under a different name.

  ```zena
  match (record) {
    case { a: 1, b }: b          // binds `b` to record.b
    case { a as first }: first   // binds record.a as `first`
  }
  ```

- **Tuple Patterns**: Match tuples and destructure elements.

  ```zena
  case let (1, x): ...
  ```

- **Logical Patterns**: Combine patterns using `|` (OR) and `&` (AND).

  ```zena
  case 1 | 2: ... // Matches 1 or 2
  case let Point { x } & { y }: ... // Matches Point and binds x and y
  ```

Patterns can be nested.

```zena
case let Point { x: 0, y: (1, z) }: ...
```

#### Names in Patterns

Whether a name in a pattern _binds_ a new variable or _refers_ to something
that already exists is decided syntactically, by the enclosing `let`/`var` —
never by whether the name happens to resolve.

- Under a `let` or `var`, every name in the pattern binds. `let` distributes
  into nested patterns, so `case let Point { x, y }` binds both `x` and `y`.
- Otherwise a bare name is a reference: it must name a class, and it matches
  instances of that class. A name that resolves to nothing is an error.
- Shorthand fields (`{ x }`) always bind, since they are destructuring; use
  `as` to bind a field under a different name.

This is why a mistyped variant name is reported instead of quietly becoming a
catch-all:

```zena
match (shape) {
  case Circle: "circle"
  case Squre:  "square" // Error: 'Squre' does not name a class. Did you mean 'Square'?
}
```

Zena deliberately does not follow Rust in using capitalization to decide
binder-versus-matcher. Making the decision depend on a naming convention means
a name that is merely misspelled still parses as a valid binding; making it
depend on the explicit `let`/`var` (as Swift does) means every unresolved name
is a diagnosable error.

There is no pattern that compares against an existing variable's _value_. Use a
guard instead:

```zena
match (x) {
  case let n if n == expected: "matched"
  case _: "other"
}
```

#### Guard Patterns

Match cases can include an optional guard expression using `if`. The guard is a
boolean expression that must evaluate to `true` for the case to match. The guard
can reference variables bound in the pattern.

```zena
match (x) {
  case let i if i > 10: "greater than 10"
  case let i if i < 0: "negative"
  case _: "between 0 and 10"
}
```

#### Block Cases

Match cases can contain a block of statements. The value of the block is the
value of the last expression.

```zena
match (x) {
  case 1: {
    let result = x * 2;
    result + 1
  }
  case _: 0
}
```

#### Exhaustiveness CheckingMatch expressions must be exhaustive, meaning they must cover all possible values of the discriminant type. If the compiler detects that some values are not covered, it will report an error.

```zena
type T = 1 | 2;
let x: T = 1;

// Error: Non-exhaustive match. Remaining type: 2
match (x) {
  case 1: "one"
}

// OK
match (x) {
  case 1: "one"
  case 2: "two"
}
```

You can use a wildcard pattern `_` or a variable pattern to cover all remaining
cases.

```zena
match (x) {
  case 1: "one"
  case _: "other"
}
```

The compiler also checks for unreachable cases. If a case appears after a
pattern that covers all remaining possibilities (like a wildcard), it is flagged
as unreachable.

## 7. Classes and Objects

Zena supports object-oriented programming with classes.

### Class Declaration

Classes are declared using the `class` keyword.

```zena
class Point {
  x: i32;       // Immutable field (default)
  var y: i32;   // Mutable field

  new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  moveY(dy: i32) {
    this.y = this.y + dy;  // OK - y is mutable
    // this.x = 0;         // Error - x is immutable
  }
}
```

### Field Mutability

Fields are **immutable by default**. Use `var` to make a field mutable. The
`let` modifier is accepted but redundant — bare fields are already immutable.
Field types can be inferred from their initializer expression.

### Optional Fields

Fields can be marked optional with `?`, which makes their type `T | null`:

```zena
class TreeNode {
  value: i32;
  var left?: TreeNode;   // Type is TreeNode | null
  var right?: TreeNode;  // Type is TreeNode | null

  new(value: i32) : value = value {}
}
```

Optional fields are syntactic sugar for a union with `null`. The same
restrictions apply: **primitive types cannot be optional** (since `i32 | null`
would require boxing). Optional fields work in classes, interfaces, and mixins.

```zena
interface Container {
  child?: Element;       // OK: reference type
  // count?: i32;        // Error: primitives cannot be optional
}

mixin Linkable {
  var next?: Node;
}
```

### Case Classes

A class with a parameter list after its name is a **case class** — a concise
declaration that auto-generates fields, a constructor, `operator ==`, and
`hashCode()`:

```zena
class Point(x: f64, y: f64)
```

This desugars to a class with immutable fields and a constructor that assigns
each parameter to the corresponding field.

**Case classes are implicitly final** — they cannot be extended by other
classes. This ensures the correctness of auto-generated equality (which uses
exact type identity) and enables WASM `sub final` optimization.

Case classes can also have a body
for additional members:

```zena
class Point(x: f64, y: f64) {
  distance(): f64 { return sqrt(x * x + y * y); }
}
```

#### Mutable fields

By default, case class parameters become immutable fields. Use `var` for
mutable fields:

```zena
class Counter(name: String, var count: i32)
// name is immutable, count is mutable
```

#### Optional parameters

Case class parameters can be marked optional with `?`. Optional parameters
become nullable fields (`T | null`) and can be omitted in the constructor call:

```zena
class Node(value: i32, label?: String)
// label has type `String | null`

let a = new Node(1);          // label defaults to null
let b = new Node(1, 'hello'); // label is 'hello'
```

Optional and mutable can be combined:

```zena
class Config(name: String, var cache?: i32)
```

#### Generic case classes

```zena
class Pair<A, B>(first: A, second: B)
class Box<T>(value: T)
```

#### Inheritance

Case classes support `extends`, `with`, and `implements`:

```zena
class Binary(left: Expr, right: Expr) extends Expr
class Event(name: String) with Timestamped implements Hashable
```

The class body is optional when there are no additional members.

```zena
class User {
  id: i32;                    // Immutable (default)
  let created: i64;           // Immutable (explicit, same as bare)
  var email: String;          // Mutable
  var(#phone) phone: String;  // Mutable with private setter
}
```

| Syntax                  | Getter | Setter                  | Mutability |
| ----------------------- | ------ | ----------------------- | ---------- |
| `name: Type`            | Public | None (constructor only) | Immutable  |
| `let name: Type`        | Public | None (constructor only) | Immutable  |
| `var name: Type`        | Public | Public                  | Mutable    |
| `var(#name) name: Type` | Public | Private (`#name`)       | Mutable    |

#### Private Setters

The `var(#name)` syntax creates a field that is publicly readable but only
writable via the private name:

```zena
class Counter {
  var(#count) count: i32 = 0;

  increment() {
    this.#count = this.count + 1;  // Write via #count
  }
}

let c = new Counter();
let n = c.count;  // OK - reading is public
c.count = 5;      // Error - no public setter
```

### Initializer Lists

For immutable fields that need constructor parameters, use Dart-style initializer
lists. Expressions in the initializer list cannot reference `this`:

```zena
class Point {
  let x: i32;
  let y: i32;

  // Initializer list before the body
  new(x: i32, y: i32) : x = x, y = y { }
}

class Rectangle {
  let width: i32;
  let height: i32;
  let area: i32;

  // Can compute values from parameters
  new(w: i32, h: i32) : width = w, height = h, area = w * h { }
}
```

Initializer list expressions can reference:

- Constructor parameters
- Earlier fields in the initializer list (by bare name)

They **cannot** reference `this` because the object doesn't exist yet.

#### Derived Classes

For derived classes, `super()` must appear as the **last** entry in the initializer list:

```zena
class Point3D extends Point {
  let z: i32;

  // Initialize z, then call super
  new(x: i32, y: i32, z: i32) : z = z, super(x, y) {
    // Body runs after super(), full this access
  }
}
```

This ensures subclass fields are initialized before the superclass constructor runs,
preventing uninitialized field access if the superclass calls virtual methods.

#### Restrictions

- Only actual fields can be initialized (not setters/accessors)
- `super()` is required for derived classes and must be last
- Private fields use `#` prefix: `new(x: i32) : #field = x { }`

#### Semicolon Body

Constructors with no body logic can use a semicolon instead of `{}`:

```zena
class Point {
  let x: i32;
  let y: i32;
  new(x: i32, y: i32) : x = x, y = y;
}

class Empty {
  new();
}
```

#### `this.` Constructor Parameters

For the common pattern of constructor parameters that directly assign to fields,
use Dart-style `this.field` parameters. The type is inferred from the field declaration:

```zena
class Point {
  let x: i32;
  let y: i32;
  new(this.x, this.y);
}
```

This is equivalent to:

```zena
class Point {
  let x: i32;
  let y: i32;
  new(x: i32, y: i32) : x = x, y = y;
}
```

`this.` parameters can be mixed with regular parameters and explicit initializer lists:

```zena
class Rect {
  width: i32;
  height: i32;
  new(this.width, this.height, scale: i32)
    : width = width * scale, height = height * scale {}
}
```

When combined with an explicit initializer list, the `this.` assignments are applied
first, then the explicit initializer list entries (which can override them).

### Sealed Classes

A `sealed` class restricts which classes can extend it. All variants must be
declared in the same source file using `case` declarations inside the class body.

Sealed classes are implicitly abstract — they cannot be instantiated directly,
only their variants can:

```zena
sealed class Shape {
  case Circle(radius: i32)
  case Rect(width: i32, height: i32)
}

let s: Shape = new Circle(5); // OK
// new Shape() would be an error — sealed classes are abstract
```

Each `case` declaration creates a subclass with the specified fields. Variants
can also be declared without fields (**unit variants**):

```zena
sealed class Color {
  case Red, Green, Blue
}
```

Unit variants are allocated as singletons — multiple calls to `new Red()`
return the same instance.

Instances are created with `new`:

```zena
let s: Shape = new Circle(5);
let c: Color = new Green();
```

#### Exhaustive pattern matching

Match expressions on sealed class types must cover all variants:

```zena
let area = match (s) {
  case let Circle { radius as r }: r * r * 3
  case let Rect { width as w, height as h }: w * h
};
```

Unit variants use identifier patterns:

```zena
let name = match (c) {
  case Red: "red"
  case Green: "green"
  case Blue: "blue"
};
```

#### Distributed variants

Variants can also be declared as separate classes that extend the sealed base.
These must still be listed in the sealed class's `case` declaration:

```zena
sealed class Expr {
  case Add, Lit
}

class Add(left: Expr, right: Expr) extends Expr
class Lit(value: i32) extends Expr
```

A distributed variant can itself be a sealed class, enabling nested sum types
(sum of sums):

```zena
sealed class Node {
  case Expr, Stmt
}

sealed class Expr extends Node {
  case Binary, Literal
}
```

Only classes named in the `case` declaration may extend a `sealed` class.

#### Abstract fields

Sealed and abstract classes can declare `abstract` fields. An abstract field
has no storage in the base class — subclasses must provide a concrete field
or case parameter with the same name and type:

```zena
sealed class Node {
  case Binary, Literal
  abstract loc: i32;
}

class Binary(left: Node, right: Node, loc: i32) extends Node
class Literal(value: i32, loc: i32) extends Node
```

The abstract field generates a virtual getter in the base class vtable,
so it can be accessed polymorphically:

```zena
let getLoc = (n: Node): i32 => n.loc;  // dispatches via vtable
```

Abstract fields can also be satisfied by regular fields in non-case subclasses:

```zena
abstract class Base {
  abstract id: i32;
}

class Derived extends Base {
  id: i32;
  new(id: i32) : id = id, super() {}
}
```

### Generic Classes

Classes can be generic by specifying type parameters:

```zena
class Box<T> {
  value: T;

  new(value: T) {
    this.value = value;
  }

  getValue(): T {
    return this.value;
  }
}

let b = new Box<i32>(42);
```

Generic type parameters can be constrained using the `extends` keyword:

```zena
class Animal {
  name: String;
  new(name: String) {
    this.name = name;
  }
}

class Zoo<T extends Animal> {
  animals: array<T>;

  new() {
    this.animals = [];
  }
}
```

Multiple type parameters can have constraints that reference other type parameters:

```zena
class Container<T extends Box<V>, V> {
  item: T;

  new(item: T) {
    this.item = item;
  }
}
```

### Statics on a Generic Class

A `static` belongs to the class itself, of which there is one however
many types the class is used at. Its type parameters are therefore out
of scope inside a static — field, method and accessor alike:

```zena
class Boxed<T> {
  item: T;
  new(this.item);
  static of(v: T): Boxed<T> { ... }
  // Static method 'of' cannot use the class's type parameter 'T'.
}
```

A static that needs a type parameter declares its own, and it is solved
or written exactly as any generic function's is:

```zena
class Boxed<T> {
  item: T;
  new(this.item);
  static of<A>(v: A): Boxed<A> { return new Boxed<A>(v); }
  static none<A>(): Boxed<A> | null { return null; }
}

let b = Boxed.of(11);            // Boxed<i32>, solved from the argument
let e = Boxed.none<String>();    // written: nothing else determines A
```

A static that names no type parameter at all is reached through the bare
class name, and static storage is one cell shared by every use of the
class:

```zena
class Counted<T> {
  item: T;
  new(this.item);
  static var count: i32 = 0;
  static bump(): i32 { Counted.count += 1; return Counted.count; }
}
```

There is no way to write a class's type arguments in expression
position — `Counted<i32>.bump()` is not a form. A static never varies
with them, so there would be nothing for them to select.

### `void` as a Type Argument

`void` is a valid type argument. It is a **zero-width** type: a value of
type `void` occupies no space at runtime, so a `T`-typed field or
parameter simply disappears when `T` is `void`.

The visible consequence is at call sites. There is no way to write a
`void` value, so an argument for a `void` parameter is **omitted**:

```zena
class Cell<T> {
  var value: T;
  new(this.value);
  set(v: T): void { this.value = v; }
  get(): T { return this.value; }
}

let c = new Cell<void>();  // the constructor argument is omitted
c.set();                   // so is the method argument
c.get();                   // a void result is a statement, not a value
```

Omitting is permitted, not required: an expression that is _already_
`void` can be passed explicitly, and still runs for its side effects.

```zena
let log = (): void => { /* ... */ };
c.set(log());  // runs log(), stores nothing
```

Nothing but `void` is assignable to a `void` parameter, so an omitted
argument can never be silently filled by the next one along — a
misaligned argument fails its own type check.

This is what makes `Future<void>` work — the fire-and-forget async
shape — with no special case in the language:

```zena
let save = async (): Future<void> => {
  await write(data);
};

await save();  // a statement: there is no value to bind
```

### Generic Methods

Classes and Mixins can define generic methods. Type parameters are specified after the method name.

```zena
class Container {
  value: i32;

  map<T>(fn: (val: i32) => T): T {
    return fn(this.value);
  }
}
```

Generic methods can be called with explicit type arguments or inferred.

```zena
let c = new Container();
c.value = 10;
let s = c.map<String>((v) => 'Value: ' + v); // Explicit
let n = c.map((v) => v * 2); // Inferred
```

### Method Overloading

Zena supports method overloading, allowing multiple methods with the same name
but different parameter types or counts.

```zena
class Printer {
  print(val: i32): void {
    console.log('i32: ' + val);
  }

  print(val: f32): void {
    console.log('f32: ' + val);
  }

  print(val: String): void {
    console.log('string: ' + val);
  }
}

let p = new Printer();
p.print(42);      // Calls print(i32)
p.print(3.14);    // Calls print(f32)
p.print('hello'); // Calls print(string)
```

The compiler resolves the correct overload based on argument types at compile
time.

#### Overloading with Different Parameter Counts

Methods can also be overloaded by having different numbers of parameters:

```zena
class Calculator {
  add(a: i32): i32 {
    return a;
  }

  add(a: i32, b: i32): i32 {
    return a + b;
  }

  add(a: i32, b: i32, c: i32): i32 {
    return a + b + c;
  }
}
```

#### Operator Overloading

Classes can define custom behavior for operators like `+`, `==`, `[]`, and
`[]=`.

##### Binary Operators

The `operator +` method enables custom addition behavior:

```zena
class Vector {
  x: i32;
  y: i32;

  new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  operator +(other: Vector): Vector {
    return new Vector(this.x + other.x, this.y + other.y);
  }
}

let v1 = new Vector(1, 2);
let v2 = new Vector(3, 4);
let v3 = v1 + v2; // Vector(4, 6)
```

The `operator ==` method enables custom equality comparison:

```zena
class Point {
  x: i32;
  y: i32;

  operator ==(other: Point): boolean {
    return this.x == other.x && this.y == other.y;
  }
}
```

##### Index Operators

Overloading also works with index operator methods:

```zena
class MultiMap {
  data: Map<i32, String>;

  operator [](key: i32): String {
    return this.data.get(key);
  }

  operator [](key: String): String {
    // Lookup by string key (hashed)
    return this.data.get(hash(key));
  }
}
```

#### Inheritance and Overloading

Subclasses can override specific overloads while inheriting others:

```zena
class Base {
  process(val: i32): i32 {
    return val;
  }

  process(val: f32): i32 {
    return 100;
  }
}

class Child extends Base {
  // Override only the i32 version
  process(val: i32): i32 {
    return val * 2;
  }
  // Inherits process(f32) from Base
}
```

Subclasses can also add new overloads not present in the base class.

````

- **Fields**: Immutable by default. Use `var` for mutable fields. See [Field Mutability](#field-mutability).
- **Constructor**: Named `new`.
- **Methods**: Functions defined within the class.

### Extension Classes

Extension classes allow adding methods to existing types. This is useful for extending built-in types or types from other modules without modifying their definition.

```zena
extension class ArrayExtensions<T> on array<T> {
  // Add methods to array<T>
  last(): T {
    return this[this.length - 1];
  }
}
````

- **`extension class`**: Keywords to define an extension.
- **`on Type`**: Specifies the type being extended.
- **`declare` fields**: Extension classes can declare fields that exist on the
  underlying type but are not implemented in the extension (e.g., for
  intrinsics).

```zena
export final extension class FixedArray<T> on array<T> {
  @intrinsic('array.len')
  declare length: i32;
}
```

#### Constructors

An extension-class constructor builds a value of the extended type. It takes
only its declared parameters (there is no receiver — nothing exists yet), and
it must call `super` with exactly one argument: the underlying value, which
must be assignable to the `on` type. `new Ext(...)` evaluates to that value,
viewed as the extension type. A constructor body may follow the `super`
initializer; it runs with `this` bound to the value.

```zena
export final extension class FixedArray<T> on array<T> {
  new(length: i32, value: T) : super(__array_new(length, value));
}
```

Because extension classes are erased, `new Ext(...)` compiles to an ordinary
call — no allocation happens beyond what the `super` argument itself creates.

Rules:

- The `super` call is required: without it the constructor has no value to
  return.
- `super` takes exactly one argument, assignable to the `on` type.
- Field initializer lists (`this.x` parameters) are not available — extension
  classes cannot declare instance fields.

### Static Symbols

Static Symbols allow you to define unique identifiers for methods and fields
that are distinct from string names. This is useful for defining "protocol"
methods (like iterators) or internal APIs that should not collide with public
members.

#### Declaration

Symbols are declared using the `symbol` keyword.

```zena
// Top-level symbol
export symbol mySymbol;

// Static member symbol (Recommended for Interfaces)
interface Iterable<T> {
  static symbol iterator;
}
```

#### Usage

To define a member using a symbol, prefix the symbol name with `:`. To access a
symbol-keyed member, use `.:` followed by the symbol name.

```zena
class MyList<T> implements Iterable<T> {
  // Define a method with a symbol key
  :Iterable.iterator(): Iterator<T> {
    // ...
  }
}

let list = new MyList();
// Access a symbol-keyed method
let it = list.:Iterable.iterator();
```

#### Semantics

- **Compile-Time Resolution**: Symbols are resolved at compile time. The symbol
  name after `:` must refer to a constant symbol.
- **No Collisions**: Two interfaces can define methods with the same _name_ but
  different _symbols_, allowing a class to implement both without conflict.
- **Access Control**: Visibility is controlled via standard `export` rules. If a
  symbol is not exported, it cannot be used outside the module.
- **Distinct from Indexing**: The `:symbol` / `.:symbol` syntax is distinct from
  the `[expr]` indexing syntax (operator `[]`), avoiding ambiguity.

### Distinguishable Types & Erasure

Zena uses **type erasure** for certain constructs to maintain zero-cost
abstractions. This means that some types which are distinct at compile time are
identical at runtime.

Types that are identical at runtime are considered **indistinguishable**. This
has implications for:

- **Union Types**: A union cannot contain multiple types that are
  indistinguishable from each other.
- **Pattern Matching**: You cannot match against multiple indistinguishable
  types in the same `match` expression (as the first case would always match).
- **`is` Checks**: Checking if a value `is T` where `T` is an erased type will
  check against the underlying runtime type.

#### Indistinguishable Pairs

The following pairs of types are indistinguishable at runtime:

1.  **Extension Classes on the same type**:

    ```zena
    extension class A on array<i32> {}
    extension class B on array<i32> {}
    // A and B are both array<i32> at runtime.
    ```

2.  **Distinct Types on the same type**:

    ```zena
    distinct type IdA = String;
    distinct type IdB = String;
    // IdA and IdB are both String at runtime.
    ```

    Opaque types are erased the same way — the cast restriction is enforced
    entirely at compile time, so an `opaque type` over `String` is also
    indistinguishable from `String` at runtime.

3.  **Generic Instantiations of Erased Types**:
    ```zena
    // Box<T> is monomorphized, but if T erases to the same type, Box<T> might be the same struct.
    // Currently, Box<Meters> and Box<Seconds> (where Meters/Seconds are i32) are indistinguishable.
    ```

#### Valid Distinguishable Types

- **Classes**: `class A {}` and `class B {}` are always distinguishable.
- **Reified Generics**: `Box<i32>` and `Box<String>` are distinguishable because
  `i32` and `String` have different runtime representations.
- **Primitives**: `i32` and `String` are distinguishable.

### Limitations

Since extension classes and distinct types are erased at runtime, they have some
limitations:

1.  **Unions**: You cannot create a union type containing multiple extension
    classes or distinct types that extend the same underlying type.

    ```zena
    extension class A on array<i32> {}
    extension class B on array<i32> {}

    let x: A | B; // Error: Ambiguous union
    ```

2.  **Pattern Matching**: You cannot have multiple cases in a `match` expression
    that match against extension classes on the same underlying type.
    ```zena
    match (arr) {
      case let A {}: ...
    ```

### Records

Records are immutable, structural types that hold a fixed set of named fields.

```zena
let p = { x: 1, y: 2 };
let x = p.x;
```

#### Optional Fields

A record field marked `?` may be **absent** — this is presence, not
nullability (unlike class and interface fields, where `?` means
`T | null`). A literal may omit optional fields, and a record value
that reliably has a field may flow to a type where it is optional (the
reverse is an error — a maybe-absent field cannot satisfy a required
one):

```zena
type Opts = {url: String, timeout?: i32, retries?: i32};

let f = (opts: Opts): i32 => {
  let {timeout = 30_000, retries = 3} = opts;  // defaults where absent
  return timeout + retries;
};

f({url: '/api'});               // both absent — defaults apply
f({url: '/api', timeout: 5});   // retries absent
```

Absence is observable and consumed through patterns:

- Destructuring an optional field requires a default
  (`let {timeout = 30_000} = opts`) in irrefutable positions.
- Naming it *without* a default in an `if (let ...)` or `match`
  pattern is a presence test — the branch is taken only when the
  field is present, and the binding holds its value.

Direct member access on an optional field (`opts.timeout`) is a
compile error. Presence is tracked per field, so an explicit
`{timeout: 0}` is present — `0` never triggers a default — and spread
propagates presence (`{...partial, retries: 2}` keeps `timeout`
present or absent as it was in `partial`). A record type may have at
most 32 optional fields. For a field that is always present but whose
*value* may be missing, use `Option<T>` from `zena:option`.

#### Shorthand Syntax

If a variable name matches the field name, you can use the shorthand syntax:

```zena
let x = 1;
let y = 2;
let p = { x, y }; // Equivalent to { x: x, y: y }
```

#### Spread Syntax

You can use the spread syntax (`...`) to copy properties from another record
into a new record.

```zena
let p = { x: 1, y: 2 };
let p3 = { ...p, z: 3 }; // { x: 1, y: 2, z: 3 }
```

The spread syntax produces the same keys that are available for destructuring.
If a property is defined multiple times (e.g., via spread and explicit
assignment), the last definition wins.

```zena
let p = { x: 1, y: 2 };
let p2 = { ...p, x: 10 }; // { x: 10, y: 2 }
```

### Tuples

Tuples are immutable, structural types that hold a fixed sequence of typed
elements.

```zena
let t = (1, "hello");
let n = t[0];
```

#### Compile-Time Known Indices

Tuple indices must be compile-time known values. This includes:

- **Literal numbers**: `t[0]`, `t[1]`
- **`let` variables** initialized with number literals: `let idx = 0; t[idx]`

```zena
let t = (1, "hello", true);

// ✅ Literal index
let first = t[0];

// ✅ let variable with literal initializer
let idx = 1;
let second = t[idx];

// ❌ var variables are not compile-time known
var i = 0;
let x = t[i];  // Error: Tuple index must be a compile-time known value

// ❌ Parameters are not compile-time known
let getElement = (t: (i32, String), idx: i32) => t[idx];  // Error
```

This restriction exists because tuples have a fixed structure where each
position may have a different type. The compiler must know the index at
compile time to determine the result type.

#### Tuple Element Narrowing

Tuple elements support type narrowing just like variables. Since tuples are
immutable, type narrowing is safe—the element cannot change between the null
check and its use.

```zena
class Container {
  value: i32;
  new(value: i32) { this.value = value; }
}

let process = (t: (Container | null, i32)): i32 => {
  if (t[0] !== null) {
    // t[0] is narrowed to Container (non-null)
    return t[0].value;
  }
  return 0;
};

// Works with let indices too:
let process2 = (t: (Container | null, i32)): i32 => {
  let idx = 0;
  if (t[idx] !== null) {
    return t[idx].value;  // Narrowed to Container
  }
  return 0;
};
```

### Inline Tuples (Multi-Value Returns)

Inline tuples enable functions to return multiple values without heap
allocation. Unlike regular tuples which are boxed structs, inline tuples
compile directly to WASM multi-value returns. The `inline` keyword is
required in type position to distinguish them from boxed tuples.

```zena
// Function returning an inline tuple
let divide = (a: i32, b: i32): inline (i32, i32) => {
  return (a / b, a % b);  // quotient and remainder
};

// Destructuring the result
let (quot, rem) = divide(17, 5);
// quot = 3, rem = 2
```

**Key differences from boxed tuples:**

- Inline tuples use `inline (T1, T2)` in type position
- They only exist in return position and destructuring - they cannot be stored
  in variables or passed as arguments
- They compile to zero-allocation WASM multi-value returns

#### Boolean Literal Types

The types `true` and `false` are literal types that are subtypes of `boolean`.
This enables discriminated unions with inline tuples.

```zena
// A function that may or may not return a value
let tryParse = (s: String): inline (true, i32) | inline (false, _) => {
  if (s == "42") {
    return (true, 42);
  }
  return (false, _);  // _ is the literal for 'hole'
};
```

#### Pattern-Based Narrowing for Union Tuples

When destructuring a union of tuples with a pattern that contains literal
values, the type system automatically narrows the union based on the literal
pattern. This enables ergonomic iteration with discriminated unions.

```zena
// Iterator.next() returns inline (true, T) | inline (false, _)
// When pattern includes 'true', only (true, T) variants are considered
while (let (true, elem) = iterator.next()) {
  // elem is narrowed to T (not T | _)
  process(elem);
}

// Works with if-let as well
if (let (true, value) = maybeValue()) {
  // value is narrowed to the actual type
  return value * 2;
}
```

The narrowing works by filtering tuple union variants based on literal patterns:

```zena
let data = (): inline (true, true, i32) | inline (true, false, _) | inline (false, _, _) => { ... };

// Pattern (true, true, value) filters to just the first variant
if (let (true, true, value) = data()) {
  // value is i32, not i32 | _
}
```

This feature enables zero-allocation iteration idioms like `for-in` loops, which
internally use `while (let (true, elem) = iter.next())`.

### Mixins

Mixins in Zena allow reuse of code across class hierarchies. A mixin is declared using the `mixin` keyword and applied to a class using the `with` clause. Unlike interfaces, mixins can contain field and method implementations.

```zena
mixin Timestamped {
  createdAt: i64;
  touch() {
    this.createdAt = now();
  }
}

class Document with Timestamped {
  content: String;
  new(this.content) : createdAt = now();
}
```

#### The `on` Clause

Mixins can restrict their target classes using the `on` clause, which guarantees that `this` in the mixin is treated as a subtype of the constrained type:

```zena
mixin Syncable on Entity {
  sync(): void {
    this.save(); // OK: save() is defined on Entity
  }
}
```

#### Constraint Satisfaction and Type Checking

A target class satisfies a mixin's `on` constraint if the constrained type is assignable to:

1. The target class's **superclass**.
2. The target class's **extension `on` type** (if it is an extension class).
3. Any interface in the target class's **`implements` list**.

This enables a class to implement an interface (e.g. `Iterable<T>`) **via** a mixin that is constrained to that interface (e.g. `on Iterable<T>`). When type checking:

1. The class declares `implements Iterable<T>`, immediately satisfying the mixin's `on` constraint.
2. The mixin is applied, injecting the required implementation methods.
3. The compiler validates that the class has implemented all members of the interface, which succeeds because of the injected mixin methods.

## 8. Modules & Exports

### Imports

Modules bring exported names from other files into scope using the `import` keyword:

```zena
// Import named bindings
import { Map, Set } from 'zena:collections';

// Import with alias
import { StringBuilder as SB } from 'zena:string-builder';

// Import all exports into a namespace
import * as math from 'zena:math';
```

#### Namespace Imports

A namespace import (`import * as x`) defines a read-only variable `x` whose type is a structural **`RecordType`** containing all of the value exports of the imported module as properties.

Since namespace variables are compiled as standard structural records:

- They are first-class values that can be passed to functions, returned, or stored in data structures.
- They can be destructured using record destructuring syntax: `let { add, sub } = math;`.

### Exports

Top-level declarations (variables, functions, classes) can be exported using the
`export` keyword. This exposes them to other modules or the host environment.

```zena
// Export a function
export let add = (a: i32, b: i32) => a + b;

// Export a class
export class Point {
  x: i32;
  y: i32;
  new(this.x, this.y);
}
```

### Imports (Host Interop)

Zena allows importing functions from the host environment using the `declare`
keyword and the `@external` decorator.

```zena
@external("env", "log")
declare function log(val: i32): void;
```

- **`@external(module, name)`**: Specifies the WASM import module and name.
- **`declare function`**: Defines the function signature. The function body is
  omitted.

These declarations map to WebAssembly imports, allowing Zena to call JavaScript
functions (or other WASM modules).

#### Re-exports

Symbols can be re-exported from other modules using `export { ... } from` or
`export * from`:

```zena
// Re-export specific names
export { Point, distance } from './geometry.zena';

// Re-export with alias
export { helper as util } from './helpers.zena';

// Re-export all exports from a module
export * from './types.zena';
```

## 9. Intrinsics

Intrinsics are special functions that map directly to compiler-generated code or
WebAssembly instructions. They are primarily used to implement the standard
library and low-level primitives.

Intrinsics are declared using the `@intrinsic` decorator on a `declare function`
statement.

### Equality Intrinsic (`eq`)

The `eq` intrinsic provides a generic equality check that works across all
types.

```zena
@intrinsic('eq')
declare function equals<T>(a: T, b: T): boolean;
```

The behavior depends on the type `T`:

- **Primitives (`i32`, `f32`, `boolean`)**: Performs value equality.
- **Strings**: Performs value equality (byte-wise comparison).
- **Reference Types (Classes, Arrays, Records)**:
  - By default, performs **reference equality** (checks if both operands refer
    to the same object).
  - If the type implements `operator ==`, the intrinsic performs a **virtual
    method call** to that operator.

#### Custom Equality with `operator ==`

Classes can customize equality behavior by implementing `operator ==`.

```zena
class Point {
  x: i32;
  y: i32;

  new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  operator ==(other: Point): boolean {
    return this.x == other.x && this.y == other.y;
  }
}

let p1 = new Point(1, 2);
let p2 = new Point(1, 2);

// equals(p1, p2) returns true because Point implements operator ==
```

### Hash Intrinsic (`hash`)

The `hash` intrinsic computes a hash code for a value, suitable for use in hash
maps.

```zena
@intrinsic('hash')
declare function hash<T>(val: T): i32;
```

The behavior depends on the type `T`:

- **`i32`, `u32`, `boolean`**: Returns the value itself (or 1/0 for boolean).
- **`i64`, `u64`**: Folds high and low bits: `wrap(x ^ (x >>> 32))`.
- **`f32`, `f64`**: Hashes the float's bits, adding `+0.0` first so `-0.0`
  and `+0.0` (which compare equal) hash equally.
- **Strings**: Computes the FNV-1a hash of the string bytes (cached on the
  string after the first computation).
- **Classes**:
  - If the class implements a `hashCode(): i32` method, it is called.
  - Otherwise, returns 0 (fallback).

The `hash` and `eq` intrinsics are implementation details of the hash-based
collections; they are not exported from the standard library. User code should
rely on the `Hashable` interface and the `==` operator instead.

### The `Hashable` Interface

Hash-based collections constrain their key types to the `Hashable` interface
from `zena:hashable`:

```zena
export interface Hashable {
  hashCode(): i32;
}

// In zena:collections (HashMap and HashSet are also in zena:map and zena:set):
class HashMap<K extends Hashable, V> { ... }
class HashSet<T extends Hashable> { ... }
class OrderedHashMap<K extends Hashable, V> { ... }
class OrderedHashSet<T extends Hashable> { ... }
```

The contract: if two values are equal (per the `eq` intrinsic's semantics — a
virtual call to `operator ==` when the class defines one, reference equality
otherwise), they must return the same `hashCode()`. A class that uses
reference equality should return an identity hash (e.g. a per-instance
counter assigned at construction).

Classes must declare `implements Hashable` explicitly (interface conformance
is nominal), with two exceptions:

- **`String`** implements `Hashable` in the standard library.
- **Case classes** implicitly implement `Hashable`: their `hashCode()` and
  `operator ==` are compiler-generated (structural, with reference-typed
  fields hashed and compared by value where the field type supports it), and
  they are assignable to `Hashable` without an explicit clause.

In addition, the following types satisfy a `Hashable` constraint (though they
are not assignable to `Hashable` as values, since that would require boxing):

- **Numeric primitives** (`i32`, `u32`, `i64`, `u64`, `f32`, `f64`) and
  **`boolean`**, which hash by value.
- **Enums** and **distinct types**, judged by their underlying type.

### Pure Accessor Decorator (`@pure`)

The `@pure` decorator is used on **explicit accessor declarations** (properties
with custom getters/setters) to indicate that the setter has no side effects
beyond storing the value. This enables the compiler to perform dead code
elimination on write-only accessors.

**Plain fields are always pure** - they don't need the `@pure` decorator because
they simply store values without side effects. Write-only plain fields are
automatically eliminated.

```zena
class Message {
  // Plain fields - automatically eliminated if write-only (no decorator needed)
  timestamp: i32;
  sessionId: i32;

  // Field that is used - kept
  content: i32;

  // Explicit accessor with side effects - requires @pure to enable elimination
  @pure
  metadata: i32 {
    get {
      return this.#backingStore;
    }
    set(v) {
      this.#backingStore = v;  // Pure setter - just stores value
    }
  }

  #backingStore: i32;

  new(content: i32) {
    this.timestamp = 1000;  // Written but never read → eliminated
    this.sessionId = 999;   // Written but never read → eliminated
    this.content = content;
    this.metadata = 42;     // Written but never read → eliminated (marked @pure)
  }

  getContent(): i32 {
    return this.content;  // Only content is read
  }
}
```

**Dead Code Elimination Rules**:

- **Plain fields**: Write-only fields are automatically eliminated (they're
  always pure).
- **Explicit accessors with `@pure`**: Write-only accessors marked `@pure` are
  eliminated.
- **Explicit accessors without `@pure`**: Kept even if write-only (may have side
  effects).
- **Read fields**: Always kept, regardless of `@pure` decorator.
- **Polymorphic access**: Prevents elimination.

**Use Cases**: This is particularly useful for generated code (like protocol
buffers) where large schemas are defined but only a small subset of fields are
actually used.

**Example**:

```zena
// In the example above:
// - timestamp, sessionId → eliminated (plain fields, write-only)
// - metadata → eliminated (accessor marked @pure, write-only)
// - content → kept (read in getContent)
// Binary size reduced by eliminating 6 methods (3 getters + 3 setters)
```

## 10. Standard Library

Zena includes a small standard library of utility classes. These are
automatically imported into every module.

### Arrays

#### FixedArray\<T\>

`FixedArray<T>` is a fixed-size array backed directly by a WASM-GC array. The
`[...]` literal syntax creates a `FixedArray`:

```zena
let nums = [1, 2, 3];              // FixedArray<i32>
let names = ["Alice", "Bob"];       // FixedArray<String>
let empty: FixedArray<i32> = [];    // empty (type annotation required)
```

Elements are accessed and mutated by index. `.length` returns the array size:

```zena
let arr = [10, 20, 30];
let first = arr[0];       // 10
arr[1] = 99;              // mutate in place
let len = arr.length;     // 3
```

#### Array\<T\>

`Array<T>` is a growable array that automatically resizes its backing storage.
Use `Array.from()` to create one from a fixed array, or `new Array<T>()` for
an empty growable array. A literal syntax for growable arrays is planned.

```zena
let grow = Array.from([1, 2, 3]);   // Array<i32> from FixedArray
grow.push(4);                       // [1, 2, 3, 4]

let empty = new Array<i32>();       // empty growable array
```

### Map<K, V>

A mutable hash map implementation.

#### Map Literal Syntax

Maps can be created using the literal syntax `{key => value, ...}`:

```zena
let scores = {"Alice" => 95, "Bob" => 87};     // Map<String, i32>
let lookup = {1 => "one", 2 => "two"};          // Map<i32, String>

// Multi-line with trailing comma
let config = {
  "host" => "localhost",
  "port" => 8080,
};
```

The `=>` separator distinguishes map literals from record literals (which use `:`).
Key and value types are inferred from the entries.

#### Explicit Construction

Maps can also be created explicitly:

```zena
let map = new Map<String, i32>();
map.set("one", 1);
map["two"] = 2;  // operator []= syntax
```

#### Accessing Values

`Map.get(key)` returns an inline tuple `(V, boolean)` indicating the value and
whether the key was found:

```zena
let (value, found) = map.get("one");
if (found) {
  console.log(value);
}
```

The index operator `map[key]` throws `KeyNotFoundError` if the key doesn't exist.

### Box<T>

A wrapper class for holding values. This is particularly useful for using
primitive types in contexts that require reference types, such as Union Types.

```zena
let b = new Box(42);
let val: Box<i32> | null = b;
```

## 11. Exception Handling

Zena supports throwing exceptions using the `throw` keyword.

### Throw Expression

The `throw` expression interrupts execution and unwinds the stack. It evaluates
to the `never` type, meaning it can be used in any context where a value is
expected.

```zena
throw new Error("Something went wrong");

let x: i32 = throw new Error("Boom"); // Valid, x is never assigned
```

The expression thrown must be an instance of the `Error` class (or a subclass).

### Error Class

The `Error` class is part of the standard library and is available globally.

```zena
class Error {
  message: String;
  new(message: String) { this.message = message; }
}
```

## 12. Resource Management

### `using`

`using` releases a value when it leaves the enclosing block. It takes any
`Disposable` — a class carrying the symbol-keyed `:dispose()` member declared
by `Disposable` in `zena:ownership`:

```zena
import { Disposable } from 'zena:ownership';

class Lock implements Disposable {
  :Disposable.dispose(): void { release(this.handle); }
}

let update = (): void => {
  using guard = acquire(lock);
  // … use guard …
};   // guard.:Disposable.dispose() runs here
```

Release runs on **every** path leaving the block — an early `return`, a
`break` or `continue` out of an enclosing loop, and exception unwind — and
multiple `using` bindings in one block release in reverse declaration order:

```zena
using a = open('a');
using b = open('b');   // b is released first
```

A returned value is computed before anything is released, so `return
guard.read()` still reads a live resource.

A binding is optional:

```zena
using acquire(lock);        // scope-bound, nothing to name
using file = open(path);    // bound
```

`using` is an immutable declaration: it declares the binding itself, and both
`using let x = …` and `using var x = …` are rejected.

Two obligations on `dispose` implementations, neither checked by the compiler:
it must be **idempotent**, since a value may be disposed more than once, and it
must **not throw**, since it runs on unwind paths where a second exception
would displace the one being propagated.

`using` takes any `Disposable`, resource or not. A resource — a value holding
something the garbage collector cannot reclaim — carries `:dispose()` like
anything else, so `using` releases it normally rather than rejecting it or
skipping it.

A `Borrow<R>` is rejected. A borrow is temporary access to something another
party owns, and never releases what it points at.

`using` earns its keep on ordinary disposables — a lock guard, a tracing span,
a transaction. See [docs/design/ownership.md](design/ownership.md).

### Implicit drop

An owned resource is released when its binding's block exits, without a
`using`:

```zena
let f = open(path);   // f: Own<File>
read(f);              // a borrow: f stays live
                      // f.:Disposable.dispose() runs here
```

The release runs on every path out of the block — falling off the end,
`return`, `break`/`continue`, and exception unwind — after a returned value
is computed, and in reverse declaration order when several bindings release
at one exit. A `using` on a resource is therefore redundant rather than
wrong: disposal is idempotent, so the second release does nothing.

The compiler releases a binding only when it still owns the value at every
exit. A binding is left alone when anything moves it (a call taking
`Own<R>`, `disown`, a consuming method, rebinding), reassigns it, captures
it in a closure, or uses it in a position the compiler does not recognize
as a borrow — and, for now, when it was declared in a value-producing
block, a generator, or an `async` body. Left alone means what it always
meant before implicit drop: the value leaks unless something else releases
it.

A move on one arm of an `if` releases the binding at the end of the other
arm, so it is uniformly dead after the merge — and a use there is the
use-after-move error either way:

```zena
let f = open(path);
if (handOff) {
  pool.give(f);   // moved
}                 // not handing off? released here
```

Release timing is observable when `dispose` has effects: a resource
declared in an inner block releases at that block's `}`, before the code
after it runs.

## 13. Compilation

### Dead Code Elimination

The Zena compiler performs aggressive dead code elimination (DCE) to produce
minimal WASM binaries. This tree-shaking operates at multiple levels:

- **Declaration-level**: Functions, classes, and interfaces that are not
  reachable from exported entry points are excluded from the output.
- **Type-level**: WASM types for intrinsic methods and fields are not generated
  if the intrinsic is not actually called.
- **VTable-level**: Classes with no virtual methods skip vtable generation
  entirely.

DCE ensures that standard library components (like `Map` or `Console`) are only
included in the output if they are actually used by the program. This is
critical for network delivery of WASM modules.

### Binary Size

Zena is designed to produce the smallest possible WASM binaries. Key
optimizations include:

- **Monomorphization**: Generic types are specialized at compile time, avoiding
  runtime type metadata.
- **Static dispatch**: Private and final methods use direct calls instead of
  vtable lookups.
- **Intrinsics**: Built-in operations compile to inline WASM instructions, not
  function calls.
- **No runtime**: Zena programs have no mandatory runtime overhead beyond
  WASM-GC's garbage collector.

A minimal Zena program can compile to as few as 41 bytes.

## 15. Grammar (Simplified)

```ebnf
Module ::= Statement*

Statement ::= ExportStatement | VariableDeclaration | UsingStatement | ExpressionStatement | BlockStatement | ReturnStatement | BreakStatement | ContinueStatement | IfStatement | WhileStatement | ForStatement

ExportStatement ::= "export" (VariableDeclaration | ClassDeclaration | InterfaceDeclaration | MixinDeclaration | DeclareFunction)

VariableDeclaration ::= ("let" | "var") Identifier "=" Expression ";"

UsingStatement ::= "using" ("let" Identifier (":" Type)? "=")? Expression ";"

ExpressionStatement ::= Expression ";"

BlockStatement ::= "{" Statement* "}"

ReturnStatement ::= "return" Expression? ";"

BreakStatement ::= "break" ";"

ContinueStatement ::= "continue" ";"

IfStatement ::= "if" "(" (Expression | LetPatternCondition) ")" Statement ("else" Statement)?

WhileStatement ::= "while" "(" (Expression | LetPatternCondition) ")" Statement

LetPatternCondition ::= "let" Pattern "=" Expression

ForStatement ::= "for" "(" ForInit? ";" Expression? ";" Expression? ")" Statement

ForInit ::= VariableDeclaration | Expression

Expression ::= ArrowFunction | AssignmentExpression | BinaryExpression | CallExpression | NewExpression | MemberExpression | ArrayLiteral | IndexExpression | TemplateLiteral | TaggedTemplateExpression | ThrowExpression | UnaryExpression

AssignmentExpression ::= (Identifier | MemberExpression | IndexExpression) ("=" | "+=" | "-=" | "*=" | "/=" | "%=") Expression

CallExpression ::= Expression "(" (Expression ("," Expression)*)? ")"

NewExpression ::= "new" Identifier "(" (Expression ("," Expression)*)? ")"

MemberExpression ::= Expression "." Identifier

ArrayLiteral ::= "[" (Expression ("," Expression)*)? "]"

IndexExpression ::= Expression "[" Expression "]"

TemplateLiteral ::= "`" TemplateSpan* "`"

TemplateSpan ::= TemplateChars | "${" Expression "}"

TaggedTemplateExpression ::= Expression TemplateLiteral

ThrowExpression ::= "throw" Expression

UnaryExpression ::= ("!" | "-") Expression

ArrowFunction ::= "(" ParameterList? ")" (":" TypeAnnotation)? "=>" Expression

ParameterList ::= Parameter ("," Parameter)*

Parameter ::= Identifier ":" TypeAnnotation

BinaryExpression ::= PrimaryExpression (Operator PrimaryExpression)*

PrimaryExpression ::= NumberLiteral | StringLiteral | Identifier | "(" Expression ")"

Operator ::= "+" | "-" | "*" | "/" | "%" | "&" | "|" | "&&" | "||"
```

### Destructuring

Zena supports destructuring for Records, Tuples, and Classes.

#### Record Destructuring

```zena
let p = { x: 10, y: 20 };
let { x, y } = p;
let { x as a, y as b } = p; // Renaming
```

#### Tuple Destructuring

```zena
let t = (10, 20);
let (a, b) = t;
let (first, , third) = (1, 2, 3); // Skipping elements
```

#### Class Destructuring

Class instances can be destructured similar to records.

```zena
class Point {
  x: i32;
  y: i32;
}
let p = new Point(10, 20);
let {x, y} = p;
```
