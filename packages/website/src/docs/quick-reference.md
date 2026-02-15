---
layout: docs.njk
title: Zena Quick Reference
description: A concise reference covering every Zena language feature.
---

# Zena Quick Reference

Zena is a statically typed, object-oriented and functional programming language
targeting WebAssembly GC. It combines TypeScript-like syntax with a sound type
system and low- or zero-cost abstractions.

## Quick Start

```ts
// hello.zena
export let main = () => {
  return 42;
};
```

> **Note**: Zena is not yet released. The CLI examples below assume you've built
> the Zena tools locally from the [GitHub
> repository](https://github.com/porfirioribeiro/zena).

```bash
# Compile for host environment (JS)
zena build hello.zena -o hello.wasm --target host

# Compile for WASI
zena build hello.zena -o hello.wasm --target wasi

# Run with wasmtime
wasmtime run -W gc,function-references,exceptions --invoke main hello.wasm
```

## Basic Syntax

### Comments

Zena uses C-style comments: `//` for single-line and `/* */` for multi-line.
JSDoc-style comments (`/** */`) are recommended for documenting public APIs.

```ts
// Single-line comment

/* Multi-line
   comment */

/** JSDoc-style comment (recommended for public APIs) */
```

### Identifiers

Identifiers name variables, functions, classes, and other entities.

- Must start with a letter, `_`, or `$`
- Can contain letters, digits, `_`, or `$`
- Case-sensitive

### Semicolons

Semicolons are required after most statements. They're optional after
block-ended constructs (`if`, `match`, `try`) when used as standalone
statements.

```ts
let x = 1;                    // Required
if (x > 0) {
  /* ... */
}                             // Optional
let y = if (x > 0) 1 else 2;  // Required (expression context)
```

## Modules

Every Zena source file is a module. Modules provide namespacing and control
visibility—top-level declarations are private by default.

### Imports

Use `import` to bring declarations from other modules into scope:

```ts
// Named imports
import {Map, Set} from 'zena:collections';

// Renamed import
import {StringBuilder as SB} from 'zena:string-builder';

// Namespace import
import * as regex from 'zena:regex';
regex.match(pattern, text);

// Alternative syntax (from ... import)
from 'zena:string' import {String};
```

### Exports

Mark declarations with `export` to make them available to other modules and the
host environment:

```ts
export let add = (a: i32, b: i32) => a + b;

export class Point {
  x: i32;
  y: i32;
  #new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }
}

// Private (not exported)
let helper = (x: i32) => x * 2;
```

## Variables

Zena uses `let` and `var` to declare variables. Both are block-scoped and can
appear at module level or in nested scopes. Variables can be shadowed in inner
scopes but cannot be redeclared in the same scope. Unlike JavaScript, variables
cannot be referenced before their declaration.

```ts
let x = 1; // Immutable binding (like const in JS)
var y = 1; // Mutable binding
y = 2;     // OK
x = 2;     // ❌ Error: cannot reassign immutable binding
```

### Type Annotations

Type annotations are optional—the compiler infers types from initializers.
Literals are widened to their base type: integer literals become `i32`, float
literals become `f32`, and string literals become `String` (not literal types
like `1` or `"hello"`).

```ts
let x: i32 = 1;          // Explicit type
let y = 1;               // Inferred as i32
let s: String = 'hello'; // Explicit String type
```

## Primitive Types

Zena's primitive types map directly to WebAssembly value types, with no boxing
overhead. Integer and float literals default to `i32` and `f32` respectively;
use `as` to convert to other numeric types.

| Type      | WASM Type       | Description                                          |
| --------- | --------------- | ---------------------------------------------------- |
| `i32`     | `i32`           | 32-bit signed integer (default for integer literals) |
| `i64`     | `i64`           | 64-bit signed integer                                |
| `u32`     | `i32`           | 32-bit unsigned (uses unsigned WASM operators)       |
| `u64`     | `i64`           | 64-bit unsigned (uses unsigned WASM operators)       |
| `f32`     | `f32`           | 32-bit float (default for float literals)            |
| `f64`     | `f64`           | 64-bit float                                         |
| `boolean` | `i32`           | `true` or `false`                                    |
| `String`  | `(ref $String)` | Immutable Unicode string                             |
| `anyref`  | `anyref`        | Top type for all reference types                     |
| `any`     | `anyref`        | Can hold any value (primitives are auto-boxed)       |
| `never`   | —               | Bottom type (e.g., result of `throw`)                |

```ts
let i: i32 = 42;
let n: i64 = 100 as i64;
let u: u32 = 255 as u32;
let f: f32 = 3.14;
let d: f64 = 3.14 as f64;
let b: boolean = true;
let s: String = 'hello';
```

## Built-in Types (Prelude)

The following types are automatically available in every Zena module—no import
needed. They come from the _prelude_, which is implicitly imported.

| Type                    | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `String`                | Immutable Unicode string                           |
| `Error`                 | Base class for all errors (thrown with `throw`)    |
| `IndexOutOfBoundsError` | Thrown on invalid array/string index access        |
| `Option<T>`             | Represents an optional value (`Some<T>` or `None`) |
| `Some<T>`               | Variant of `Option` containing a value             |
| `None`                  | Variant of `Option` representing no value          |
| `Array<T>`              | Growable array (literal syntax: `#[1, 2, 3]`)      |
| `FixedArray<T>`         | Fixed-size array                                   |
| `ImmutableArray<T>`     | Read-only array view                               |
| `Map<K, V>`             | Hash map                                           |
| `Box<T>`                | Wraps primitives for use in unions or `any`        |
| `BoundedRange`          | Range with start and end (`1..10`)                 |
| `FromRange`             | Range with start only (`5..`)                      |
| `ToRange`               | Range with end only (`..10`)                       |
| `FullRange`             | Unbounded range (`..`)                             |
| `Sequence<T>`           | Interface for iterable collections                 |
| `MutableSequence<T>`    | Interface for mutable iterable collections         |
| `console`               | Console output (`console.log(...)`)                |

Helper functions `some(value)` and `none()` are also available for creating
`Option` values.

## Functions

All functions in Zena use arrow syntax—there is no `function` keyword. Functions
are first-class values that can be assigned to variables, passed as arguments,
and returned from other functions.

```ts
// Expression body
let add = (a: i32, b: i32) => a + b;

// Block body
let greet = (name: String): String => {
  return 'Hello, ' + name;
};

// No parameters
let getAnswer = () => 42;
```

### Generic Functions

Generic functions work with multiple types while preserving type safety. Type
parameters are specified in angle brackets before the parameter list.

```ts
let identity = <T>(x: T): T => x;

let num = identity<i32>(42); // Explicit type argument
let str = identity('hello'); // Inferred
```

### Constrained Generics

Type parameters can be constrained using `extends` to require certain
capabilities.

```ts
let print = <T extends Printable>(x: T): void => {
  // Can call methods from Printable
};
```

### Optional Parameters

Parameters marked with `?` are optional. For reference types, the parameter
becomes `T | null`. Primitive types cannot be optional without a default value
(since they can't be `null`).

```ts
// Reference types can be optional (become T | null)
let greet = (name: String, greeting?: String) => {
  if (greeting == null) {
    return 'Hello, ' + name;
  }
  return greeting + ', ' + name;
};

greet('Alice');     // "Hello, Alice"
greet('Bob', 'Hi'); // "Hi, Bob"
```

### Default Parameters

Parameters can have default values. Unlike Python, default expressions are
evaluated fresh at each call site—not shared between calls. Default values are
used when the argument is omitted entirely—there's no sentinel value like `null`
or `undefined` that triggers defaults.

```ts
let increment = (x: i32, amount: i32 = 1) => x + amount;

increment(10);    // 11 (amount defaults to 1)
increment(10, 5); // 15 (amount is 5)
```

### Argument Adaptation

Functions with fewer parameters can be passed where more are expected:

```ts
let map = (fn: (item: i32, index: i32) => i32) => { ... };

// Pass a function that ignores `index`
map((item) => item * 2);
```

### Closures

Functions are closures—they capture variables from their enclosing scope.
Captured variables are stored in a heap-allocated environment.

```ts
let makeAdder = (x: i32) => {
  return (y: i32) => x + y;
};

let add5 = makeAdder(5);
add5(10); // 15
```

### Multi-Value Returns

Functions can return multiple values using unboxed tuples. Unlike regular tuples
(which are heap-allocated), multi-value returns compile directly to WASM's
multi-value return feature—values go on the stack, not the heap. This guarantees
good performance since stack values are prime candidates for register
allocation.

```ts
let divide = (a: i32, b: i32): (i32, i32) => {
  return (a / b, a % b);
};

let (quot, rem) = divide(17, 5);  // quot=3, rem=2
```

Multi-value returns must be immediately destructured at the call site—you cannot
store them in a variable.

#### Use Case: Iterators

The `Iterator` interface uses multi-value returns for efficient iteration:

```ts
interface Iterator<T> {
  next(): (T, true) | (never, false);  // (value, hasValue)
}
```

This avoids the two-call pattern common in Java (`hasNext()` then `next()`) and
the wrapper-object pattern in JavaScript (returning `{done, value}`). A single
call returns both the status and the value with zero allocation overhead.

#### Use Case: Map Lookups

`Map.get()` uses multi-value returns to safely handle missing keys without
relying on `null`:

```ts
let map = new Map<String, i32>();
map.set('a', 42);

let(value, found) = map.get('a'); // (42, true)
let(_, found2) = map.get('b');    // (_, false)
```

This is especially important for primitive value types like `i32` where `null`
isn't an option. Instead of returning `i32 | null` (which would require boxing),
the boolean `found` flag indicates whether the lookup succeeded, and when
`found` is false, the `_` identifier is used to return a `never` value.

## Operators & Expressions

Zena provides familiar operators from C-family languages. Operators are strictly
typed—you cannot mix `i32` and `u32` without explicit casting.

### Arithmetic

```ts
let a = 1 + 2;  // Addition
let b = 5 - 3;  // Subtraction
let c = 2 * 3;  // Multiplication
let d = 10 / 3; // Division (integer: 3)
let e = 10 % 3; // Modulo (1)
```

### Comparison

Equality (`==`) uses value comparison for primitives and strings, and reference
comparison for objects (unless `operator ==` is defined). Use `===` to always
compare by reference.

```ts
a == b;  // Equal (value equality for strings)
a != b;  // Not equal
a === b; // Strict equal (reference equality)
a !== b; // Strict not equal
a < b;   // Less than
a <= b;  // Less than or equal
a > b;   // Greater than
a >= b;  // Greater than or equal
```

### Logical

```ts
a && b; // Logical AND (short-circuit)
a || b; // Logical OR (short-circuit)
!a;     // Logical NOT
```

### Bitwise

```ts
a & b;   // AND
a | b;   // OR
a ^ b;   // XOR
~a;      // NOT
a << b;  // Left shift
a >> b;  // Right shift (signed)
a >>> b; // Right shift (unsigned)
```

### Type Operators

The `as` operator casts between types (checked at runtime for reference types).
The `is` operator tests types and enables type narrowing.

```ts
x as i64      // Type cast (checked at runtime)
x is MyClass  // Type check (returns boolean)
```

### Range Operators

Ranges represent sequences of indices, primarily for array slicing and
iteration. All ranges are half-open (exclusive end).

```ts
1..10     // BoundedRange [1, 10)
5..       // FromRange (5 to end)
..10      // ToRange (start to 10)
..        // FullRange (all elements)
```

### Operator Precedence (highest to lowest)

1. Unary: `!`, `-`, `~`
2. Multiplicative: `*`, `/`, `%`
3. Additive: `+`, `-`
4. Type cast/check: `as`, `is`
5. Range: `..`
6. Shift: `<<`, `>>`, `>>>`
7. Relational: `<`, `<=`, `>`, `>=`
8. Equality: `==`, `!=`, `===`, `!==`
9. Bitwise AND: `&`
10. Bitwise XOR: `^`
11. Bitwise OR: `|`
12. Logical AND: `&&`
13. Logical OR: `||`

> **Note**: `as` currently binds looser than arithmetic, so `a + b as i64` means
> `(a + b) as i64`. We may change this in the future to match other languages
> where `as` binds tightly.

## Control Flow

Zena's control flow is expression-oriented—`if` and `match` can return values.
This enables concise conditional expressions without ternary operators.

### If Statement / Expression

Like Rust, `if` can be used as an expression. When used as an expression, the
`else` branch is required and both branches must have compatible types.

```ts
// Statement
if (x > 0) {
  // ...
} else if (x < 0) {
  // ...
} else {
  // ...
}

// Expression (else required)
let abs = if (x >= 0) x else -x;
```

### While Loop

Standard while loop with a boolean condition.

```ts
var i = 0;
while (i < 10) {
  i = i + 1;
}
```

### For Loop (C-style)

Traditional C-style for loop with init, condition, and update expressions. Note:
use `var` for the loop variable since it needs to be mutable.

```ts
for (var i = 0; i < 10; i = i + 1) {
  // ...
}
```

### For-In Loop

Iterate over any collection that implements the iteration protocol.

```ts
let arr = #[1, 2, 3];
for (let item in arr) {
  // item is 1, 2, 3
}
```

### Break and Continue

```ts
while (true) {
  if (done) break;
  if (skip) continue;
}
```

### Let-Pattern Conditions

Combine pattern matching with conditionals using `if let` and `while let`. The
condition succeeds if the pattern matches.

```ts
// if-let
if (let Some(value) = maybeValue) {
  // value is bound here
}

// while-let
while (let (true, item) = iterator.next()) {
  // item is bound here
}
```

## Pattern Matching

Zena's `match` expression provides exhaustive pattern matching. Unlike `switch`,
match is an expression that returns a value, and the compiler ensures all cases
are covered.

```ts
let result = match (x) {
  case 0: "zero"
  case 1: "one"
  case n if n < 0: "negative"
  case _: "other"
};
```

### Pattern Types

Patterns can match literals, bind variables, destructure data structures, and
combine with logical operators.

```ts
// Literals
case 42: ...
case "hello": ...
case true: ...
case null: ...

// Identifier (binds value)
case x: x + 1

// Wildcard (matches anything)
case _: ...

// Tuple destructuring
case [a, b]: a + b

// Record destructuring
case { x, y }: x + y

// Class destructuring
case Point { x: 0, y }: "on y-axis"

// Or patterns
case 1 | 2 | 3: "small"

// Guard patterns
case n if n > 100: "large"
```

### Block Cases

```ts
match (x) {
  case 1: {
    let doubled = x * 2;
    doubled + 1
  }
  case _: 0
}
```

### Exhaustiveness

Match expressions must cover all possible values:

```ts
type Status = "ok" | "error";
let s: Status = "ok";

match (s) {
  case "ok": ...
  case "error": ...  // Required for exhaustiveness
}
```

## Strings

Strings in Zena are immutable sequences of Unicode text. The internal encoding
(WTF-8 or WTF-16) is abstracted away—you work with characters and code points,
not bytes.

String literals can be written with single quotes (`'...'`), double quotes
(`"..."`), or backticks (`` `...` ``). Single and double quotes are equivalent.
Backticks create _template literals_ that support multi-line content and
`${...}` interpolation.

```ts
let s1 = 'hello'; // Single quotes
let s2 = 'world'; // Double quotes (equivalent)
let s3 = 'line1\nline2'; // Escape sequences

// Template literals (backticks)
let name = 'Alice';
let greeting = `Hello, ${name}!`; // Interpolation

// Multi-line (only with backticks)
let text = `
  This is
  multi-line
`;
```

### Escape Sequences

| Sequence | Meaning                    |
| -------- | -------------------------- |
| `\n`     | Newline                    |
| `\r`     | Carriage return            |
| `\t`     | Tab                        |
| `\\`     | Backslash                  |
| `\"`     | Double quote               |
| `\'`     | Single quote               |
| `\$`     | Dollar sign (in templates) |
| `\xNN`   | Hex byte                   |
| `\uNNNN` | Unicode code point         |

### String Operations

String slicing is O(1) and shares backing storage with the original string—no
copying required. Use `copy()` when you need to release the parent string's
memory.

```ts
let s = 'hello';
s.length;      // Length in code units
s.slice(1, 3); // "el" (O(1), shares backing storage)
s.copy();      // Force a copy (release parent memory)
s + ' world';  // Concatenation
```

### StringBuilder

Use `StringBuilder` for efficient concatenation when building strings in a loop.
For simple `a + b + c` expressions, regular concatenation is fine.

```ts
import {StringBuilder} from 'zena:string-builder';

let sb = new StringBuilder();
sb.append('Hello');
sb.append(', ');
sb.append('World!');
let result = sb.toString(); // "Hello, World!"
```

### StringReader

Use `StringReader` for parsing strings. It provides a cursor-based API that
safely handles UTF-8 boundaries, making it ideal for tokenizers and parsers.

```ts
import {StringReader} from 'zena:string-reader';

let r = new StringReader('hello world');
r.skipWhitespace();
let start = r.mark();
while (!r.isAtEnd && r.peekByte() != 32) {
  // 32 = space
  r.advance();
}
let word = r.sliceFrom(start); // "hello"
```

### Tagged Template Literals

Template literals can be _tagged_ with a function that processes the template.
The tag function receives the static string parts and interpolated values
separately.

```ts
let highlight = (
  strings: TemplateStringsArray,
  ...values: Array<any>
): String => {
  let result = new StringBuilder();
  for (var i = 0; i < values.length; i = i + 1) {
    result.append(strings[i]);
    result.append('**');
    result.append(values[i] as String);
    result.append('**');
  }
  result.append(strings[strings.length - 1]);
  return result.toString();
};

let name = 'Zena';
highlight`Hello, ${name}!`; // "Hello, **Zena**!"
```

The `TemplateStringsArray` is guaranteed to be referentially stable—the same
template literal in source code always produces the same array instance. This
enables caching based on array identity.

#### Raw Strings

Tag functions can access unprocessed string content (with escape sequences
intact) via the `raw` property:

```ts
let showEscapes = (strings: TemplateStringsArray): String => {
  return strings.raw[0]; // Escape sequences not processed
};

showEscapes`line1\nline2`; // "line1\\nline2" (literal backslash-n)
```

#### The `regex` Tag

The `regex` tag from `zena:regex` compiles a regular expression at runtime. It
uses raw strings, so you don't need to double-escape backslashes:

```ts
import {regex} from 'zena:regex';

// Without tagged template: must escape backslashes
let r1 = new Regex('\\d+\\.\\d+');

// With regex tag: write patterns naturally
let r2 = regex`\d+\.\d+`; // Same pattern, easier to read
```

## Type System

Zena has a sound type system—if your code compiles, it won't have type errors at
runtime. The type system combines nominal typing (for classes) with structural
typing (for records and functions).

### Type Aliases

Type aliases create a new name for a type without creating a new type. Aliases
are interchangeable with their underlying type.

```ts
type ID = String;
type Point = {x: i32; y: i32};
type Callback = (result: String) => void;
type Container<T> = {value: T};
```

### Distinct Types

Create nominally distinct types from existing types:

```ts
distinct type Meters = i32;
distinct type Seconds = i32;

let m: Meters = 10 as Meters;
let s: Seconds = 5 as Seconds;

let x = m + s;  // ❌ Error: type mismatch
```

### Union Types

Union types represent values that can be one of several types. All types in a
union must be _distinguishable at runtime_—the compiler rejects unions where it
can't tell the types apart.

```ts
let x: String | null = null;
x = "hello";

// Union narrowing
if (x != null) {
  // x is String here
}

if (x is MyClass) {
  // x is MyClass here
}
```

**Union restrictions:**

- Primitives cannot mix with other types: `i32 | null` is not allowed - Literal
unions of the same primitive are fine: `1 | 2 | 3` works
- Extension classes on the same base type cannot be unioned (indistinguishable)
- Use `Box<T>` to put primitives in unions with references: `Box<i32> | null`

### Literal Types

Literal types represent exact values. Combined with unions, they create
enumeration-like types with precise type checking.

```ts
type Mode = 'read' | 'write';
type Level = 1 | 2 | 3;

let mode: Mode = 'read';
let level: Level = 2;
```

### Function Types

```ts
type BinaryOp = (a: i32, b: i32) => i32;
type Predicate<T> = (item: T) => boolean;
```

### Type Narrowing

The type system narrows types based on control flow:

```ts
let process = (x: String | null) => {
  if (x == null) {
    return 'empty';
  }
  // x is String here
  return x.length;
};
```

### Nominal vs Structural

- **Nominal**: Classes, interfaces, distinct types (identity matters)
- **Structural**: Records, tuples, functions (shape matters)

```ts
class A {
  x: i32;
}
class B {
  x: i32;
}
// A and B are NOT compatible (nominal)

type R1 = {x: i32};
type R2 = {x: i32};
// R1 and R2 ARE compatible (structural)
```

## Enums

Enums define a set of named constants. They're distinct types—you can't
accidentally use a raw integer where an enum is expected.

```ts
// Integer-backed (default)
enum Color {
  Red, // 0
  Green, // 1
  Blue, // 2
}

// Explicit values
enum Status {
  Ok = 200,
  NotFound = 404,
}

// String-backed
enum Direction {
  Up = 'UP',
  Down = 'DOWN',
}

let c: Color = Color.Red;
let n: i32 = c as i32; // Explicit cast required
```

## Records & Tuples

Records and tuples are immutable, structural data types. Two records with the
same shape are compatible, regardless of where they're defined.

### Records

Records are immutable objects with named fields. They support shorthand syntax
and spreading.

```ts
let p = {x: 1, y: 2};
let x = p.x; // 1

// Shorthand
let x = 1;
let y = 2;
let p = {x, y}; // { x: 1, y: 2 }

// Spread
let p2 = {...p, z: 3}; // { x: 1, y: 2, z: 3 }
```

### Tuples

Tuples are fixed-length sequences where each position can have a different type.

```ts
let t = [1, 'hello'];
let n = t[0]; // 1
let s = t[1]; // "hello"
```

### Destructuring

Destructuring extracts values from records, tuples, and class instances into
separate variables.

```ts
// Record
let { x, y } = point;
let { x as a, y as b } = point;  // Rename

// Tuple
let [first, second] = tuple;
let [a, , c] = [1, 2, 3];  // Skip elements
```

## Classes

Classes are nominal types with fields, methods, and constructors. They compile
to WASM-GC structs, with vtables (WASM tables) generated as needed for virtual
dispatch. Classes support single [inheritance](#inheritance), can implement
multiple [interfaces](#interfaces), and can include [mixins](#mixins).

```ts
class Point {
  x: i32;
  y: i32;

  #new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  move(dx: i32, dy: i32): void {
    this.x = this.x + dx;
    this.y = this.y + dy;
  }

  distanceFromOrigin(): f32 {
    return sqrt((this.x * this.x + this.y * this.y) as f32);
  }
}

let p = new Point(3, 4);
p.move(1, 1);
```

### Fields

Fields are public by default. Public fields are _virtual_—they're inherited by
subclasses and can be overridden with accessors. This means field access may
involve a virtual call.

```ts
class Rectangle {
  width: i32;   // Public, virtual
  height: i32;  // Public, virtual
}

class Square extends Rectangle {
  // Override width with an accessor that keeps width == height
  width: i32 {
    get { return this.height; }
    set(v) { this.height = v; }
  }
}
```

### Private Fields

Private fields use the `#` prefix. They're only accessible within the class, are
not inherited, and have no virtual dispatch overhead.

```ts
class Counter {
  #count: i32; // Private, direct access

  #new() {
    this.#count = 0;
  }

  increment(): void {
    this.#count = this.#count + 1;
  }

  get(): i32 {
    return this.#count;
  }
}
```

### Getters and Setters

Accessors define computed properties. They can override inherited fields or
stand alone. Use `get` for read-only, or both `get` and `set` for read-write.

```ts
class Rectangle {
  width: i32;
  height: i32;

  area: i32 {
    get {
      return this.width * this.height;
    }
  }
}
```

### Inheritance

Classes can extend one parent class using `extends`. The child inherits all
fields and methods, and can override methods.

```ts
class Animal {
  name: String;

  #new(name: String) {
    this.name = name;
  }

  speak(): String {
    return '...';
  }
}

class Dog extends Animal {
  #new(name: String) {
    super(name);
  }

  speak(): String {
    return 'Woof!';
  }
}
```

### Generic Classes

Classes can have type parameters. Zena uses monomorphization—`Box<i32>` and
`Box<string>` are completely separate types at runtime.

```ts
class Box<T> {
  value: T;

  #new(value: T) {
    this.value = value;
  }

  map<U>(fn: (val: T) => U): Box<U> {
    return new Box<U>(fn(this.value));
  }
}

let b = new Box<i32>(42);
```

### Static Members

Static fields and methods belong to the class itself, not instances. Access them
using the class name.

```ts
class Math {
  static PI: f32 = 3.14159;

  static max(a: i32, b: i32): i32 {
    return if (a > b) a else b;
  }
}

let pi = Math.PI;
let m = Math.max(3, 5);
```

### Modifiers

`abstract` classes cannot be instantiated and may have abstract methods. `final`
classes cannot be extended, and `final` methods cannot be overridden.

```ts
abstract class Shape {
  abstract area(): f32;
}

final class Circle extends Shape {
  radius: f32;

  #new(radius: f32) {
    this.radius = radius;
  }

  area(): f32 {
    return 3.14159 * this.radius * this.radius;
  }
}
```

### Extension Classes

Add methods to existing types:

```ts
extension class StringExt on String {
  isEmpty(): boolean {
    return this.length == 0;
  }
}

"hello".isEmpty();  // false
"".isEmpty();       // true
```

### Operator Overloading

Classes can overload operators to provide custom behavior for built-in syntax.

#### operator ==

Define custom equality. Called by `==` and the `eq` intrinsic.

```ts
class Point {
  x: i32;
  y: i32;

  operator ==(other: Point): boolean {
    return this.x == other.x && this.y == other.y;
  }
}

let a = new Point(1, 2);
let b = new Point(1, 2);
a == b;  // true (calls operator ==)
a === b; // false (reference equality)
```

#### operator []

Define index access for custom collections. Implement `get` for reading and
`set` for writing.

```ts
class Grid {
  #data: FixedArray<i32>;
  #width: i32;

  operator [](x: i32, y: i32): i32 {
    get {
      return this.#data[y * this.#width + x];
    }
    set(value) {
      this.#data[y * this.#width + x] = value;
    }
  }
}

let grid = new Grid(10, 10);
grid[3, 4] = 42;      // calls operator [] set
let v = grid[3, 4];   // calls operator [] get
```

The index operator can take any number of parameters. For single-index access
(like arrays), use one parameter. For multi-dimensional access (like matrices or
grids), use multiple parameters.

### Method Overloading

Classes can have multiple methods with the same name but different parameter
types or counts. The compiler resolves the correct overload at compile time
based on argument types.

```ts
class Printer {
  print(val: i32): void {
    console.log('Integer: ' + val);
  }

  print(val: String): void {
    console.log('String: ' + val);
  }

  print(val: i32, count: i32): void {
    for (var i = 0; i < count; i = i + 1) {
      console.log(val);
    }
  }
}

let p = new Printer();
p.print(42); // Calls print(i32)
p.print('hello'); // Calls print(String)
p.print(7, 3); // Calls print(i32, i32)
```

Overload resolution is always static—the compiler picks the method based on the
declared types at the call site, not the runtime type of arguments. This is
different from virtual dispatch, which selects the method _implementation_ at
runtime based on the object's actual type.

```ts
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
  // Inherits the f32 version from Base
}

let c: Base = new Child();
c.process(10); // Overload i32 selected at compile time
// Virtual dispatch calls Child.process(i32) → 20
c.process(3.14); // Overload f32 selected at compile time
// Calls Base.process(f32) → 100
```

## Interfaces

Interfaces define contracts that classes must fulfill. A class can implement
multiple interfaces. Interface values use "fat pointers" (object + vtable) at
runtime.

```ts
interface Drawable {
  draw(): void;
}

interface Resizable {
  resize(factor: f32): void;
}

class Circle implements Drawable, Resizable {
  radius: f32;

  #new(radius: f32) {
    this.radius = radius;
  }

  draw(): void {
    // ...
  }

  resize(factor: f32): void {
    this.radius = this.radius * factor;
  }
}
```

### Generic Interfaces

```ts
interface Container<T> {
  get(): T;
  set(value: T): void;
}
```

### Interface Inheritance

```ts
interface Named {
  name: String { get; }
}

interface Person extends Named {
  age: i32 { get; }
}
```

## Mixins

Mixins provide reusable chunks of functionality that can be composed into
classes. Unlike interfaces, mixins include implementation. A class can include
multiple mixins using the `with` clause.

```ts
mixin Timestamped {
  createdAt: i64;

  touch(): void {
    this.createdAt = getCurrentTime();
  }
}

mixin Named {
  name: String;
}

class Document with Timestamped, Named {
  content: String;

  #new(name: String, content: String) {
    this.name = name;
    this.content = content;
    this.createdAt = getCurrentTime();
  }
}
```

## Arrays & Collections

Zena provides both fixed-size and growable arrays, plus a hash map. All
collections are generic and type-safe.

### FixedArray

`FixedArray<T>` has a fixed size set at creation and maps directly to a WASM-GC
array. Use it when you know the size upfront and want minimal overhead.

```ts
let arr = new FixedArray<i32>(10); // Size 10, initialized to 0
arr[0] = 42;
let len = arr.length; // 10
```

### Array

`Array<T>` is a growable array that automatically resizes. Use the `#[...]`
literal syntax to create arrays.

```ts
let arr = #[1, 2, 3];     // Array literal
arr.push(4);              // [1, 2, 3, 4]
let len = arr.length;     // 4
let first = arr[0];       // 1
```

### Slicing

Use range syntax to slice arrays. Slices share backing storage with the original
array.

```ts
let arr = #[1, 2, 3, 4, 5];
let slice = arr[1..4];    // [2, 3, 4] (view, shares storage)
let copy = arr[1..4].copy();  // Independent copy
```

### Map

`Map<K, V>` is a hash map. Keys must implement equality and hashing. Values are
nullable—`get` returns `V | null`.

```ts
let map = new Map<String, i32>();
map.set('one', 1);
map['two'] = 2;

let val = map['one']; // i32 | null
if (val != null) {
  // use val
}
```

### Iteration

Use `for-in` to iterate over any collection that implements the iteration
protocol.

```ts
let arr = #[1, 2, 3];
for (let item in arr) {
  // item is 1, 2, 3
}

let map = new Map<String, i32>();
for (let [key, value] in map) {
  // iterate over entries
}
```

## Boxing

Primitive types (`i32`, `f32`, `boolean`) cannot be used in union types because
they have a different memory representation than references. Use `Box<T>` to
wrap primitives when needed.

```ts
let maybeNumber: Box<i32> | null = new Box(42);

if (maybeNumber != null) {
  let n = maybeNumber.value;
}
```

### Auto-boxing with `any`

The `any` type accepts any value. Primitives are automatically boxed when
assigned to `any`, and unboxed when cast back.

```ts
let x: any = 42; // Auto-boxed to Box<i32>
let n = x as i32; // Unboxed back to 42
```

## Exception Handling

Zena uses exceptions for error handling, compiled to WASM exception handling
instructions.

### Throw

The `throw` expression has type `never` and can be used anywhere an expression
is expected.

```ts
throw new Error("Something went wrong");

// throw has type 'never', can be used anywhere
let x: i32 = throw new Error("Boom");
```

### Error Class

All thrown values must be `Error` or a subclass. Create custom error types by
extending `Error`.

```ts
class Error {
  message: String;
  #new(message: String) {
    this.message = message;
  }
}

// Custom errors
class ValidationError extends Error {
  field: String;
  #new(field: String, message: String) {
    super(message);
    this.field = field;
  }
}
```

## Host Imports

Use `declare` with `@external` to import functions from the host environment.
These become WASM imports that must be provided by the host (JavaScript, WASI
runner, etc.).

```ts
@external("env", "log")
declare function log(val: i32): void;

@external("env", "now")
declare function now(): i64;
```

## Intrinsics & Decorators

Intrinsics and decorators provide low-level control over code generation and
enable standard library implementation.

### @intrinsic

Intrinsics map to compiler-generated code or direct WASM instructions. Used
primarily in the standard library.

```ts
@intrinsic('eq')
declare function equals<T>(a: T, b: T): boolean;

@intrinsic('hash')
declare function hash<T>(val: T): i32;
```

### @pure

Mark accessors as side-effect free. This enables the compiler to eliminate
unused writes during dead code elimination.

```ts
class Data {
  @pure
  value: i32 {
    get { return this.#backing; }
    set(v) { this.#backing = v; }
  }
  #backing: i32;
}
```

## Type Casting

The `as` operator performs type casts. Numeric conversions compile to WASM
conversion instructions. Reference type casts are checked at runtime and throw
if invalid.

```ts
// Numeric conversions
let n: i64 = 100 as i64;      // i32 to i64
let f: f32 = 10 as f32;       // i32 to f32
let i: i32 = 3.14 as i32;     // f32 to i32 (truncates)

// Distinct types (zero-cost)
distinct type ID = i32;
let id = 42 as ID;

// Reference types (checked at runtime)
let obj: any = getObject();
let p = obj as Point;         // Throws if not a Point
```

## Standard Library

Zena's standard library is organized into modules. Types from the
[prelude](#built-in-types-prelude) are available without imports; other modules
must be explicitly imported.

### zena:math

Math functions that map directly to WASM instructions—no runtime overhead.

```ts
import {sqrt, floor, ceil, abs, min, max} from 'zena:math';

sqrt(16.0); // 4.0
floor(3.7); // 3.0
ceil(3.2); // 4.0
abs(-5.0); // 5.0
min(3.0, 7.0); // 3.0
max(3.0, 7.0); // 7.0
```

Also includes bit manipulation: `clz` (count leading zeros), `ctz` (count
trailing zeros), `popcnt` (population count).

### zena:console

Console output for logging and debugging. The `console` global is automatically
available in every module (via the prelude), so you don't need to import it.

```ts
console.log('Hello, world!');
console.error('Something went wrong');
console.warn('This is a warning');
console.info('FYI');
console.debug('Debug info');
```

The console implementation is selected based on the `--target` flag:

- **`--target host`**: Uses imported JavaScript functions (`env.console_log`,
  etc.) that the host must provide
- **`--target wasi`**: Writes directly to stdout/stderr using WASI file
  descriptors

This means the same Zena code works in both browser/Node.js environments and
standalone WASI runtimes like wasmtime.

### zena:string-builder

Efficient string concatenation for loops. See [StringBuilder](#stringbuilder).

```ts
import {StringBuilder} from 'zena:string-builder';
```

### zena:string-reader

Cursor-based string parsing. See [StringReader](#stringreader).

```ts
import {StringReader} from 'zena:string-reader';
```

### zena:regex

A regular expression engine based on Thompson NFA (similar to RE2 and Go's
`regexp`). Guarantees O(n×m) time complexity—no backtracking, no ReDoS
vulnerabilities.

```ts
import {Regex, regex} from 'zena:regex';

// Constructor
let r = new Regex('\\d+');

// Template tag (no double-escaping needed)
let r2 = regex`\d+\.\d+`;

// Matching
let m = r.match('abc123def');
if (m != null) {
  m.group(0); // "123"
}

// Flags: (?i) case-insensitive, (?m) multiline, (?s) dot-matches-newline
let r3 = regex`(?i)hello`;
```

**Supported**: Literals, alternation (`|`), character classes (`[a-z]`, `\d`,
`\w`, `\s`), quantifiers (`*`, `+`, `?`, `{n,m}`), non-greedy (`*?`, `+?`),
groups (capturing and non-capturing), anchors (`^`, `$`, `\b`).

**Not supported** (by design): Backreferences and lookahead/lookbehind—these
require backtracking which breaks the linear time guarantee.

### zena:json

JSON parsing with typed accessors and optional comment support.

```ts
import {parseJson, JsonObject, JsonArray} from 'zena:json';

let obj = parseJson('{"name": "Zena", "version": 1}') as JsonObject;
obj['name']; // "Zena" (as any)
obj['version']; // 1 (as any, boxed)

// With options
let config = parseJson(text, {
  allowComments: true, // Allow // and /* */ comments
  trackLocations: false, // Track source locations for errors
}) as JsonObject;
```

JSON values are represented as `JsonObject`, `JsonArray`, `String`, `Box<f64>`,
`Box<boolean>`, or `null`.

### zena:test

Test framework for writing unit tests. Tests are defined using `suite()` and
`test()` functions, and you must export a variable named `tests`.

```ts
import {suite, test} from 'zena:test';
import {equal, isTrue} from 'zena:assert';

export let tests = suite('math', () => {
  test('adds numbers', () => {
    equal(1 + 1, 2);
  });

  test('comparisons', () => {
    isTrue(3 > 2);
  });
});
```

### zena:assert

Assertion functions for tests. All assertions throw `AssertionError` on failure.

```ts
import {equal, notEqual, isTrue, isFalse, isNull, isNotNull, throws} from 'zena:assert';

equal(actual, expected);           // actual == expected
notEqual(actual, expected);        // actual != expected
same(actual, expected);            // actual === expected (reference equality)
notSame(actual, expected);         // actual !== expected
isTrue(value);                     // value === true
isFalse(value);                    // value === false
isNull(value);                     // value === null
isNotNull(value);                  // value !== null
greater(a, b);                     // a > b
greaterOrEqual(a, b);              // a >= b
less(a, b);                        // a < b
lessOrEqual(a, b);                 // a <= b
throws(() => { ... });             // function throws an exception
doesNotThrow(() => { ... });       // function does not throw
fail('message');                   // always fails
```

### zena:fs

File system operations (WASI target only).

```ts
import {readFile, writeFile} from 'zena:fs';

let content = readFile('input.txt');
writeFile('output.txt', content);
```
