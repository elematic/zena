---
title: 'Quick Reference'
description: 'Every Zena language feature on one page, with short examples.'
---

Zena is a statically typed, object-oriented and functional programming language
targeting WebAssembly GC. It combines TypeScript-like syntax with a sound type
system and low- or zero-cost abstractions.

## Quick Start

```zena
// hello.zena
export function main() {
  return 42;
}
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

```zena
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

```zena
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

```zena
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

Namespace imports (`import * as x`) define a read-only variable `x` whose type is a structural **`RecordType`** containing all of the value exports of the imported module as properties. They behave as standard record values and can be passed to functions, returned, stored, or destructured.

### Exports

Mark declarations with `export` to make them available to other modules and the
host environment:

```zena
export let add = (a: i32, b: i32) => a + b;

export class Point {
  x: i32;
  y: i32;
  new(x: i32, y: i32) {
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

```zena
let x = 1; // Immutable binding (like const in JS)
var y = 1; // Mutable binding
y = 2; // OK
x = 2; // ❌ Error: cannot reassign immutable binding
```

### Type Annotations

Type annotations are optional—the compiler infers types from initializers.
Literals are widened to their base type: integer literals become `i32`, float
literals become `f32`, and string literals become `String` (not literal types
like `1` or `"hello"`).

```zena
let x: i32 = 1; // Explicit type
let y = 1; // Inferred as i32
let s: String = 'hello'; // Explicit String type
```

## Primitive Types

Zena's primitive types map directly to WebAssembly value types, with no boxing
overhead. Integer and float literals default to `i32` and `f32` respectively;
use `as` to convert to other numeric types.

| Type       | WASM Type       | Description                                          |
| ---------- | --------------- | ---------------------------------------------------- |
| `i32`      | `i32`           | 32-bit signed integer (default for integer literals) |
| `i64`      | `i64`           | 64-bit signed integer                                |
| `u32`      | `i32`           | 32-bit unsigned (uses unsigned WASM operators)       |
| `u64`      | `i64`           | 64-bit unsigned (uses unsigned WASM operators)       |
| `u8` `u16` | `i32`           | Narrow unsigned; promote to `u32` in any operation   |
| `i8` `i16` | `i32`           | Narrow signed; promote to `i32` in any operation     |
| `f32`      | `f32`           | 32-bit float (default for float literals)            |
| `f64`      | `f64`           | 64-bit float                                         |
| `boolean`  | `i32`           | `true` or `false`                                    |
| `String`   | `(ref $String)` | Immutable Unicode string                             |
| `anyref`   | `anyref`        | Top type for all reference types                     |
| `any`      | `anyref`        | Can hold any value (primitives are auto-boxed)       |
| `never`    | —               | Bottom type (e.g., result of `throw`)                |

> **Note**: We are strongly considering removing the `any` type and all auto-boxing in a future release to make boxing/allocation costs explicit (requiring manual boxing using `Box<T>`).

```zena
let i: i32 = 42;
let n: i64 = 100 as i64;
let u: u32 = 255;
let f: f32 = 3.14;
let d: f64 = 3.14 as f64;
let b: boolean = true;
let s: String = 'hello';

// Narrow integers describe exact storage widths. A literal must fit,
// and arithmetic promotes to the 32-bit counterpart.
let byte: u8 = 255;
let sum: u32 = byte + 1;      // 256 — u8 does not survive the addition
let back: u8 = sum as u8;     // 0 — narrowing is explicit and truncates
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
| `Array<T>`              | Growable array (`Array.from([1, 2, 3])`)           |
| `FixedArray<T>`         | Fixed-size array (literal syntax: `[1, 2, 3]`)     |
| `ImmutableArray<T>`     | Read-only array view                               |
| `Map<K, V>`             | Hash map (literal syntax: `{"a" => 1}`)            |
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

Functions are first-class values that can be assigned to variables, passed as
arguments, and returned from other functions. They come in two forms: arrow
functions, which are expressions, and `function` declarations, which are
top-level statements.

```zena
// Expression body
let add = (a: i32, b: i32) => a + b;

// Block body
let greet = (name: String): String => {
  return 'Hello, ' + name;
};

// No parameters
let getAnswer = () => 42;
```

### Function Declarations

A `function` declaration names a function at the top level of a module. It is
hoisted, so forward references and mutual recursion just work.

```zena
export function main(): i32 {
  return isEven(10);   // declared below
}

function isEven(n: i32): i32 {
  if (n == 0) { return 1; }
  return isOdd(n - 1);
}

function isOdd(n: i32): i32 {
  if (n == 0) { return 0; }
  return isEven(n - 1);
}
```

**The difference from an arrow function is closures: a `function` can never be
one.** It may only appear at the top level, so its body sees only its own
parameters and locals plus module-level bindings — never a variable from an
enclosing scope. When you need to capture, use an arrow function.

```zena
let makeAdder = (x: i32) => (y: i32) => x + y;   // arrows capture

function bad(y: i32): i32 {
  return y + x;   // there is no enclosing `x` to capture
}
```

`gen` and `async` work the same as on arrows: `gen function items(): Iterator<i32>`,
`async function load(): Future<i32>`. Type parameters go after the name:
`function identity<T>(x: T): T`.

### Generic Functions

Generic functions work with multiple types while preserving type safety. Type
parameters are specified in angle brackets before the parameter list.

```zena
let identity = <T>(x: T): T => x;

let num = identity<i32>(42); // Explicit type argument
let str = identity('hello'); // Inferred
```

### Constrained Generics

Type parameters can be constrained using `extends` to require certain
capabilities.

```zena
let print = <T extends Printable>(x: T): void => {
  // Can call methods from Printable
};
```

### Optional Parameters

Parameters marked with `?` are optional. For reference types, the parameter
becomes `T | null`. Primitive types cannot be optional without a default value
(since they can't be `null`).

```zena
// Reference types can be optional (become T | null)
let greet = (name: String, greeting?: String) => {
  if (greeting == null) {
    return 'Hello, ' + name;
  }
  return greeting + ', ' + name;
};

greet('Alice'); // "Hello, Alice"
greet('Bob', 'Hi'); // "Hi, Bob"
```

### Default Parameters

Parameters can have default values. Unlike Python, default expressions are
evaluated fresh at each call site—not shared between calls. Default values are
used when the argument is omitted entirely—there's no sentinel value like `null`
or `undefined` that triggers defaults.

```zena
let increment = (x: i32, amount: i32 = 1) => x + amount;

increment(10); // 11 (amount defaults to 1)
increment(10, 5); // 15 (amount is 5)
```

### Argument Adaptation

Functions with fewer parameters can be passed where more are expected:

```zena
let map = (fn: (item: i32, index: i32) => i32) => { ... };

// Pass a function that ignores `index`
map((item) => item * 2);
```

### Closures

Functions are closures—they capture variables from their enclosing scope.
Captured variables are stored in a heap-allocated environment.

```zena
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

```zena
let divide = (a: i32, b: i32): (i32, i32) => {
  return (a / b, a % b);
};

let (quot, rem) = divide(17, 5);  // quot=3, rem=2
```

Multi-value returns must be immediately destructured at the call site—you cannot
store them in a variable.

#### Use Case: Iterators

The `Iterator` interface uses multi-value returns for efficient iteration:

```zena
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

```zena
let map = {"a" => 42, "b" => 100};

let (value, found) = map.get('a');  // (42, true)
let (_, found2) = map.get('c');     // (_, false)
```

This is especially important for primitive value types like `i32` where `null`
isn't an option. Instead of returning `i32 | null` (which would require boxing),
the boolean `found` flag indicates whether the lookup succeeded, and when
`found` is false, the `_` identifier is used to return a `never` value.

## Operators & Expressions

Zena provides familiar operators from C-family languages. Operators are strictly
typed—you cannot mix `i32` and `u32` without explicit casting.

### Arithmetic

```zena
let a = 1 + 2; // Addition
let b = 5 - 3; // Subtraction
let c = 2 * 3; // Multiplication
let d = 10 / 3; // Division (integer: 3)
let e = 10 % 3; // Modulo (1)
```

### Compound Assignment

```zena
var x = 10;
x += 5; // x is now 15
x -= 3; // x is now 12
x *= 2; // x is now 24
x /= 4; // x is now 6
x %= 4; // x is now 2
```

Nullish assignment assigns only when the left side is `null`:

```zena
var name: String | null = null;
name ??= 'Anonymous'; // name is now 'Anonymous'
```

Compound assignment works with variables, class fields, and array indices.
There are no `++` or `--` operators — use `+= 1` and `-= 1` instead.

### Comparison

Equality (`==`) uses value comparison for primitives and strings, and reference
comparison for objects (unless `operator ==` is defined). Use `===` to always
compare by reference.

```zena
a == b; // Equal (value equality for strings)
a != b; // Not equal
a === b; // Strict equal (reference equality)
a !== b; // Strict not equal
a < b; // Less than
a <= b; // Less than or equal
a > b; // Greater than
a >= b; // Greater than or equal
```

### Logical

```zena
a && b; // Logical AND (short-circuit)
a || b; // Logical OR (short-circuit)
!a; // Logical NOT
```

### Nullish Coalescing

The `??` operator returns the right operand when the left is `null`:

```zena
let name: String | null = null;
let display = name ?? 'Anonymous'; // 'Anonymous'
```

`??` has the same precedence as `||`.

### Optional Chaining

Safe access on potentially `null` values. Short-circuits to `null` if the
receiver is `null`.

```zena
let name = user?.name;       // Property access
let first = items?[0];       // Index access
let result = callback?(42);  // Call
let display = user?.name ?? 'Anonymous'; // With fallback
```

### Bitwise

```zena
a & b; // AND
a | b; // OR
a ^ b; // XOR
~a; // NOT
a << b; // Left shift
a >> b; // Right shift (signed)
a >>> b; // Right shift (unsigned)
```

### Type Operators

The `as` operator casts between types (checked at runtime for reference types).
The `is` operator tests types and enables type narrowing.

```zena
x as i64      // Type cast (checked at runtime)
x is MyClass  // Type check (returns boolean)
```

### Range Operators

Ranges represent sequences of indices, primarily for array slicing and
iteration. All ranges are half-open (exclusive end).

```zena
1..10     // BoundedRange [1, 10)
5..       // FromRange (5 to end)
..10      // ToRange (start to 10)
..        // FullRange (all elements)
```

### Pipeline Operator

The pipeline operator `|>` enables fluent data transformation by passing the
result of one expression as input to the next. The placeholder `$` refers to
the piped value.

```zena
// Without pipeline (inside-out)
let result = validate(transform(parse(data)));

// With pipeline (left-to-right)
let result = data |> parse($) |> transform($) |> validate($);
```

The `$` placeholder can be used multiple times and in any position:

```zena
10 |> $ + $               // 20 (use $ twice)
5 |> add($, 10)           // 15 ($ as first arg)
3 |> subtract(10, $)      // 7  ($ as second arg)
```

Pipelines can be chained and work with method calls:

```zena
text |> $.trim() |> $.toUpperCase()
1 |> $ + 1 |> $ * 2 |> $ + 3  // ((1 + 1) * 2) + 3 = 7
```

`$` is only valid inside pipeline expressions:

```zena
let x = $; // ❌ Error: '$' can only be used inside a pipeline expression
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
13. Logical OR / Nullish Coalescing: `||`, `??`
14. Pipeline: `|>`
15. Assignment: `=`, `+=`, `-=`, `*=`, `/=`, `%=`

> **Note**: `as` currently binds looser than arithmetic, so `a + b as i64` means
> `(a + b) as i64`. We may change this in the future to match other languages
> where `as` binds tightly.

## Control Flow

Zena's control flow is expression-oriented—`if` and `match` can return values.
This enables concise conditional expressions without ternary operators.

### If Statement / Expression

Like Rust, `if` can be used as an expression. When used as an expression, the
`else` branch is required and both branches must have compatible types.

```zena
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

```zena
var i = 0;
while (i < 10) {
  i = i + 1;
}
```

### For Loop (C-style)

Traditional C-style for loop with init, condition, and update expressions. Note:
use `var` for the loop variable since it needs to be mutable.

```zena
for (var i = 0; i < 10; i = i + 1) {
  // ...
}
```

### For-In Loop

Iterate over any collection that implements the iteration protocol.

```zena
let arr = [1, 2, 3];
for (let item in arr) {
  // item is 1, 2, 3
}
```

### Break and Continue

```zena
while (true) {
  if (done) break;
  if (skip) continue;
}
```

### Let-Pattern Conditions

Combine pattern matching with conditionals using `if let` and `while let`. The
condition succeeds if the pattern matches.

```zena
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

```zena
let result = match (x) {
  case 0: "zero"
  case 1: "one"
  case let n if n < 0: "negative"
  case _: "other"
};
```

### Pattern Types

Patterns can match literals, bind variables, destructure data structures, and
combine with logical operators.

```zena
// Literals
case 42: ...
case "hello": ...
case true: ...
case null: ...

// Binding (`let`/`var` binds the matched value)
case let x: x + 1

// Type pattern (a bare name must name a class; it matches instances of it)
case Circle: ...

// Wildcard (matches anything)
case _: ...

// Tuple destructuring
case let (a, b): a + b

// Record destructuring
case let { x, y }: x + y

// Shorthand fields bind, like `let { x, y } = rec` destructuring.
// `as` binds a field under a different name.
case { x, y }: x + y
case { x as first }: first

// Class destructuring
case let Point { x: 0, y }: "on y-axis"

// Or patterns
case 1 | 2 | 3: "small"

// Guard patterns
case let n if n > 100: "large"
```

### Block Cases

```zena
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

```zena
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

```zena
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

```zena
let s = 'hello';
s.length; // Length in code units
s.slice(1, 3); // "el" (O(1), shares backing storage)
s.copy(); // Force a copy (release parent memory)
s + ' world'; // Concatenation
```

### StringBuilder

Use `StringBuilder` for efficient concatenation when building strings in a loop.
For simple `a + b + c` expressions, regular concatenation is fine.

```zena
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

```zena
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

```zena
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

```zena
let showEscapes = (strings: TemplateStringsArray): String => {
  return strings.raw[0]; // Escape sequences not processed
};

showEscapes`line1\nline2`; // "line1\\nline2" (literal backslash-n)
```

#### The `regex` Tag

The `regex` tag from `zena:regex` compiles a regular expression at runtime. It
uses raw strings, so you don't need to double-escape backslashes:

```zena
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

```zena
type ID = String;
type Point = {x: i32; y: i32};
type Callback = (result: String) => void;
type Container<T> = {value: T};
```

### Distinct Types

Create nominally distinct types from existing types:

```zena
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

```zena
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

```zena
type Mode = 'read' | 'write';
type Level = 1 | 2 | 3;

let mode: Mode = 'read';
let level: Level = 2;
```

### Function Types

```zena
type BinaryOp = (a: i32, b: i32) => i32;
type Predicate<T> = (item: T) => boolean;
```

### Type Narrowing

The type system narrows types based on control flow:

```zena
let process = (x: String | null) => {
  if (x == null) {
    return 'empty';
  }
  // x is String here
  return x.length;
};
```

Narrowing also works for immutable paths (class `let` fields, record fields,
tuple elements):

```zena
class Wrapper {
  let inner: Container | null;  // Immutable field
  new() : inner = null { }
}

let process = (w: Wrapper): i32 => {
  if (w.inner !== null) {
    return w.inner.value;  // w.inner narrowed to Container
  }
  return 0;
};
```

Mutable fields (`var`) cannot be narrowed—another reference could modify the
field between the check and use.

### Nominal vs Structural

- **Nominal**: Classes, interfaces, distinct types (identity matters)
- **Structural**: Records, tuples, functions (shape matters)

```zena
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

```zena
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

```zena
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

```zena
let t = (1, 'hello');
let n = t[0]; // 1
let s = t[1]; // "hello"
```

Tuple indices must be compile-time known values:

```zena
let t = (1, 'hello', true);

let first = t[0]; // ✅ Literal index
let idx = 1; // let variable with literal initializer
let second = t[idx]; // ✅ Compile-time known

var i = 0;
let x = t[i]; // ❌ var is not compile-time known
```

Tuple elements support type narrowing since tuples are immutable:

```zena
let process = (t: (Container | null, i32)): i32 => {
  if (t[0] !== null) {
    return t[0].value; // t[0] narrowed to Container
  }
  return 0;
};
```

### Destructuring

Destructuring extracts values from records, tuples, and class instances into
separate variables.

```zena
// Record
let { x, y } = point;
let { x as a, y as b } = point;  // Rename

// Tuple
let (first, second) = tuple;
let (a, , c) = (1, 2, 3);  // Skip elements
```

## Classes

Classes are nominal types with fields, methods, and constructors. They compile
to WASM-GC structs, with vtables (WASM tables) generated as needed for virtual
dispatch. Classes support single [inheritance](#inheritance), can implement
multiple [interfaces](#interfaces), and can include [mixins](#mixins).

```zena
class Point {
  x: i32;
  y: i32;

  new(x: i32, y: i32) {
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

Fields are public and immutable by default. Public fields are _virtual_—they're
inherited by subclasses and can be overridden with accessors. This means field
access may involve a virtual call.

> **Tip**: Immutable fields work with type narrowing and make code easier to
> reason about. Use `var` when mutability is needed. Use private fields (`#`) or
> `final` classes to avoid virtual dispatch overhead. See [Field
> Mutability](#field-mutability) and [Private Fields](#private-fields).

```zena
class Rectangle {
  var width: i32;   // Public, virtual, mutable
  var height: i32;  // Public, virtual, mutable
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

```zena
class Counter {
  #count: i32; // Private, direct access

  new() {
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

### Field Mutability

Fields are **immutable by default**. Use `var` to make a field mutable. The
`let` modifier is accepted but redundant — bare fields are already immutable.
Field types can be inferred from their initializer expression.

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

The `var(#name)` syntax creates a publicly readable field with a private setter:

```zena
class Counter {
  var(#count) count: i32 = 0;

  increment(): void {
    this.#count = this.count + 1;  // Write via #count
  }
}

let c = new Counter();
let n = c.count;  // OK - reading is public
c.count = 5;      // Error - no public setter
```

### Optional Fields

Fields marked with `?` are shorthand for `Type | null`. They default to `null`
when not set in the constructor. Like explicit nullable unions, optional fields
cannot use primitive types directly—use `Box<T>` if needed.

```zena
class User {
  name: String;
  bio?: String;  // Same as bio: String | null

  new(name: String) {
    this.name = name;
    // bio defaults to null
  }
}

interface Configurable {
  label?: String;  // Optional interface field
}

mixin Timestamped {
  updatedAt?: String;  // Optional mixin field
}
```

Optional fields work with `abstract` and private (`#`) fields:

```zena
abstract class Base {
  abstract metadata?: String; // Subclasses must provide
}

class Cache {
  #lastResult?: String; // Private optional field
}
```

### Initializer Lists

For immutable fields that need constructor parameters, use Dart-style
initializer lists. The initializer list appears after `:` and before the
constructor body.

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

Initializer list expressions can reference constructor parameters and earlier
fields in the list. They **cannot** reference `this` because the object doesn't
exist yet.

For derived classes, `super()` goes at the **end** of the initializer list:

```zena
class Point3D extends Point {
  let z: i32;

  // Initialize z, then call super
  new(x: i32, y: i32, z: i32) : z = z, super(x, y) { }
}
```

Only actual fields (not setters) can appear in initializer lists.

### Getters and Setters

Accessors define computed properties. They can override inherited fields or
stand alone. Use `get` for read-only, or both `get` and `set` for read-write.

```zena
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

```zena
class Animal {
  name: String;

  new(name: String) {
    this.name = name;
  }

  speak(): String {
    return '...';
  }
}

class Dog extends Animal {
  new(name: String) {
    super(name);
  }

  speak(): String {
    return 'Woof!';
  }
}
```

### Generic Classes

Classes can have type parameters. Zena uses monomorphization—`Box<i32>` and
`Box<String>` are completely separate types at runtime.

```zena
class Box<T> {
  value: T;

  new(value: T) {
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

```zena
class Math {
  static PI: f32 = 3.14159;

  static max(a: i32, b: i32): i32 {
    return if (a > b) a else b;
  }
}

let pi = Math.PI;
let m = Math.max(3, 5);
```

On a generic class, a static that names the class's type parameters has them
bound at the call — inferred from the arguments where they determine them, and
written on the class name where they don't.

```zena
class Boxed<T> {
  item: T;
  new(this.item);
  static of(v: T): Boxed<T> { return new Boxed<T>(v); }
  static empty(): Boxed<T> | null { return null; }
}

let b = Boxed.of(11);           // Boxed<i32>, inferred
let e = Boxed<String>.empty();  // written: nothing else determines T
```

### Modifiers

`abstract` classes cannot be instantiated and may have abstract methods. `final`
classes cannot be extended, and `final` methods cannot be overridden.

```zena
abstract class Shape {
  abstract area(): f32;
}

final class Circle extends Shape {
  radius: f32;

  new(radius: f32) {
    this.radius = radius;
  }

  area(): f32 {
    return 3.14159 * this.radius * this.radius;
  }
}
```

### Extension Classes

Add methods to existing types:

```zena
extension class StringExt on String {
  isEmpty(): boolean {
    return this.length == 0;
  }
}

"hello".isEmpty();  // false
"".isEmpty();       // true
```

### Case Classes

A class with a parameter list after its name is a **case class**—a concise
declaration that auto-generates fields, a constructor, `operator ==`, and
`hashCode()`. Case classes are **implicitly final** and cannot be extended.

```zena
class Point(x: f64, y: f64)

let a = new Point(1.0, 2.0);
let b = new Point(1.0, 2.0);
a == b;    // true (structural equality)
a.x;       // 1.0
```

Case classes can have a body for additional members, and support `extends`,
`with`, and `implements`:

```zena
class Point(x: f64, y: f64) {
  distance(): f64 { return sqrt(x * x + y * y); }
}

class Counter(name: String, var count: i32)  // var for mutable fields
class Pair<A, B>(first: A, second: B)        // Generic case classes
class Event(name: String) with Timestamped implements Hashable
```

### Sealed Classes

Sealed classes restrict which classes can extend them. Only the variants listed
in the sealed class body (or explicitly allowed) may be direct subclasses. This
enables exhaustive pattern matching—the compiler knows every possible case.

Sealed classes are **implicitly abstract** and cannot be instantiated directly.

```zena
sealed class Expr {
  case Binary(left: Expr, op: String, right: Expr)
  case Literal(value: i32)
  case Unary(op: String, expr: Expr)
}

// Inline variants are case classes—with auto-generated fields, ==, hashCode

let expr = new Binary(new Literal(1), '+', new Literal(2));

// Exhaustive match—compiler ensures all cases are covered
let result = match (expr) {
  case let Binary { left, op, right }: eval(left) + eval(right)
  case let Literal { value }: value
  case let Unary { op, expr }: -eval(expr)
};
```

Variants can also be declared separately using `extends`:

```zena
sealed class Shape { }

class Circle(radius: f64) extends Shape
class Rectangle(width: f64, height: f64) extends Shape
```

### Operator Overloading

Classes can overload operators to provide custom behavior for built-in syntax.

#### operator ==

Define custom equality. Called by `==` and the `eq` intrinsic.

```zena
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

```zena
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

```zena
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

```zena
interface Drawable {
  draw(): void;
}

interface Resizable {
  resize(factor: f32): void;
}

class Circle implements Drawable, Resizable {
  radius: f32;

  new(radius: f32) {
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

```zena
interface Container<T> {
  get(): T;
  set(value: T): void;
}
```

### Interface Inheritance

```zena
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

```zena
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

  new(name: String, content: String) {
    this.name = name;
    this.content = content;
    this.createdAt = getCurrentTime();
  }
}
```

### Constraints (the `on` clause)

A mixin can restrict which classes it can be applied to by using the `on` clause. This allows the mixin to access fields and methods on `this` that are guaranteed by the constrained type:

```zena
mixin Syncable on Entity {
  sync(): void {
    this.save();  // OK: save() is defined on Entity
  }
}
```

#### Satisfying Constraints and Interface Implementation

A target class satisfies a mixin's `on` constraint if the constraint type is assignable to:

1. The target class's **superclass**.
2. The target class's **extension `on` type** (if it is an extension class).
3. Any interface in the target class's **`implements` list**.

This allows classes to implement an interface (e.g. `Iterable<T>`) **via** a mixin that is constrained to that same interface (e.g. `on Iterable<T>`). During type checking, this is resolved cleanly without circular dependency:

1. The class declares `implements Iterable<T>`, which immediately satisfies the mixin's `on Iterable<T>` constraint.
2. The mixin is applied, injecting the required utility methods into the class.
3. The compiler validates that the class fully implements all methods in `Iterable<T>`, which succeeds because the mixin provided the required methods.

For example, `HashMap` implements `Map<K, V>` (which extends `Iterable`) by mixing in `IterableUtils` (which is `on Iterable`):

```zena
// HashMap satisfies 'on Iterable' via 'implements Map'
export class HashMap<K, V> with IterableUtils<MapEntry<K, V>> implements Map<K, V> {
  // Directly implements the core iterator method
  :Iterable.iterator(): Iterator<MapEntry<K, V>> {
    return new HashMapEntryIterator<K, V>(this.#buckets);
  }

  // The utility methods (contains, all, fold, etc.) required by Iterable
  // are automatically supplied by IterableUtils!
}
```

## Arrays & Collections

Zena provides both fixed-size and growable arrays, plus a hash map. All
collections are generic and type-safe.

### FixedArray

`FixedArray<T>` has a fixed size set at creation and maps directly to a WASM-GC
array. The `[...]` literal creates a `FixedArray`.

```zena
let nums = [1, 2, 3]; // FixedArray<i32>
let arr = new FixedArray<i32>(10); // Size 10, initialized to 0
arr[0] = 42;
let len = arr.length; // 10
```

### Array

`Array<T>` is a growable array that automatically resizes. Use `Array.from()`
to create one from a fixed array, or `new Array<T>()` for an empty growable
array. A literal syntax for growable arrays is planned.

```zena
let arr = Array.from([1, 2, 3]); // Growable array from FixedArray
arr.push(4); // [1, 2, 3, 4]
let len = arr.length; // 4
let first = arr[0]; // 1

let empty = new Array<i32>(); // Empty growable array
```

### Slicing

Use range syntax to slice arrays. Slices share backing storage with the original
array.

```zena
let arr = [1, 2, 3, 4, 5];
let slice = arr[1..4];    // [2, 3, 4] (view, shares storage)
let copy = arr[1..4].copy();  // Independent copy
```

### Map

`Map<K, V>` is a hash map. Keys must satisfy the `Hashable` interface
(`hashCode(): i32`): numeric primitives, `boolean`, `String`, enums, distinct
types, and case classes satisfy it automatically; other classes must declare
`implements Hashable` and define `hashCode()`.

Maps can be created using literal syntax with `=>`:

```zena
let scores = {"Alice" => 95, "Bob" => 87};  // Map<String, i32>
let lookup = {1 => "one", 2 => "two"};       // Map<i32, String>
```

Or constructed explicitly:

```zena
let map = new Map<String, i32>();
map.set('one', 1);
map['two'] = 2;
```

Use `get()` for safe lookups—it returns `(value, found)`:

```zena
let(val, found) = map.get('one');
if (found) {
  // use val
}
```

The index operator `map[key]` throws `KeyNotFoundError` if the key doesn't exist.

### Iteration

Use `for-in` to iterate over any collection that implements the iteration
protocol.

```zena
let arr = [1, 2, 3];
for (let item in arr) {
  // item is 1, 2, 3
}

let map = new Map<String, i32>();
for (let (key, value) in map) {
  // iterate over entries
}
```

## Boxing

Primitive types (`i32`, `f32`, `boolean`) cannot be used in union types because
they have a different memory representation than references. Use `Box<T>` to
wrap primitives when needed.

```zena
let maybeNumber: Box<i32> | null = new Box(42);

if (maybeNumber != null) {
  let n = maybeNumber.value;
}
```

### Auto-boxing with `any`

The `any` type accepts any value. Primitives are automatically boxed when
assigned to `any`, and unboxed when cast back.

```zena
let x: any = 42; // Auto-boxed to Box<i32>
let n = x as i32; // Unboxed back to 42
```

## Exception Handling

Zena uses exceptions for error handling, compiled to WASM exception handling
instructions.

### Throw

The `throw` expression has type `never` and can be used anywhere an expression
is expected.

```zena
throw new Error("Something went wrong");

// throw has type 'never', can be used anywhere
let x: i32 = throw new Error("Boom");
```

### Error Class

All thrown values must be `Error` or a subclass. Create custom error types by
extending `Error`.

```zena
class Error {
  message: String;
  new(message: String) {
    this.message = message;
  }
}

// Custom errors
class ValidationError extends Error {
  field: String;
  new(field: String, message: String) {
    super(message);
    this.field = field;
  }
}
```

## Host Imports

Use `declare` with `@external` to import functions from the host environment.
These become WASM imports that must be provided by the host (JavaScript, WASI
runner, etc.).

```zena
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

```zena
@intrinsic('eq')
declare function equals<T>(a: T, b: T): boolean;

@intrinsic('hash')
declare function hash<T>(val: T): i32;
```

### @pure

Mark accessors as side-effect free. This enables the compiler to eliminate
unused writes during dead code elimination.

```zena
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
if invalid. Unnecessary casts (casting a value to its exact type) can be warned
against by enabling the CLI flag `--warn-unnecessary-casts`.

```zena
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

```zena
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

```zena
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

```zena
import {StringBuilder} from 'zena:string-builder';
```

### zena:string-reader

Cursor-based string parsing. See [StringReader](#stringreader).

```zena
import {StringReader} from 'zena:string-reader';
```

### zena:regex

A regular expression engine based on Thompson NFA (similar to RE2 and Go's
`regexp`). Guarantees O(n×m) time complexity—no backtracking, no ReDoS
vulnerabilities.

```zena
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

```zena
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

```zena
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

```zena
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

```zena
import {readFile, writeFile} from 'zena:fs';

let content = readFile('input.txt');
writeFile('output.txt', content);
```
