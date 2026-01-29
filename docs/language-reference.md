# Zena Language Reference

This document describes the syntax and semantics of the Zena programming language.

## 1. Introduction

Zena is a statically typed language targeting WebAssembly (WASM-GC). It features a TypeScript-like syntax with strict static typing and no implicit coercion.

## 1.1 Comments

Zena supports two styles of comments:

### Single-Line Comments

Single-line comments begin with `//` and continue to the end of the line.

```zena
let x = 1; // This is a single-line comment
```

### Multi-Line Comments

Multi-line comments begin with `/*` and end with `*/`. They can span multiple lines.

```zena
/* This is a
   multi-line comment */
let x = 1;

let y /* inline comment */ = 2;
```

## 1.2 Identifiers

Identifiers name variables, functions, classes, interfaces, mixins, and other entities.

- Must start with a letter (`a-z`, `A-Z`), underscore (`_`), or dollar sign (`$`).
- Subsequent characters can be letters, digits (`0-9`), underscores, or dollar signs.
- Identifiers are case-sensitive.

```zena
let _private = 1;
let $variable = 2;
let camelCase = 3;
```

## 2. Types

Zena is strongly typed. All expressions have a type determined at compile time.

### Soundness

Zena features a **sound type system**. This means that the type checker guarantees that a program that compiles successfully will not exhibit type errors at runtime. For example, if a variable is typed as `String`, it is guaranteed to always hold a string value at runtime.

This soundness is enforced by the underlying WASM-GC architecture. Zena does not support "unsafe" blocks or unchecked type assertions that could violate memory safety.

### Primitive Types

- **`i32`**: 32-bit signed integer. This is the default type for integer literals. Operations like division and comparison use signed semantics.
- **`i64`**: 64-bit signed integer. Used for large numbers. Constructed via casting (e.g., `100 as i64`).
- **`u32`**: 32-bit unsigned integer. Operations like division, modulo, and comparison use unsigned semantics. `i32` and `u32` cannot be mixed in operations without explicit casting using `as`.
- **`f32`**: 32-bit floating-point number. This is the default type for floating-point literals.
- **`f64`**: 64-bit floating-point number. Constructed via casting (e.g., `1.0 as f64`).
- **`boolean`**: Boolean value (`true` or `false`).
- **`string`**: UTF-8 string.
- **`anyref`**: The top type for all reference types. It can hold any object, array, string, function, or `null`. It cannot hold unboxed primitives (`i32`, `f32`, `boolean`).
- **`never`**: The bottom type. It represents a value that never occurs (e.g., the result of `throw` or a function that never returns). `never` is a subtype of every type.
- **`ByteArray`**: A mutable array of 8-bit integers. This is a low-level type primarily used for implementing strings and binary data manipulation.

### The `any` Type

The `any` type is a special type that can hold any value, including primitives. It is similar to `any` in TypeScript or `Object` in Java, but with stricter safety guarantees.

- **Assignment**: Any value (primitive or reference) can be assigned to a variable of type `any`.
- **Auto-boxing**: Primitive values (`i32`, `f32`, `boolean`) are automatically boxed into a `Box<T>` when assigned to `any`.
- **Safety**: You cannot perform operations on an `any` value directly. You must explicitly cast it back to a specific type using the `as` operator.
- **Unboxing**: Casting an `any` value back to a primitive type automatically unboxes it.

```zena
let x: any = 42;       // Auto-boxed to Box<i32>
let y: any = "hello";  // Reference type (string)

let n = x as i32;      // Unboxed to 42
let s = y as string;   // Cast to string

// let z = x + 1;      // Error: Operator '+' cannot be applied to type 'any'
```

The `any` type is useful for generic data structures or interop scenarios where the type is not known at compile time. Under the hood, it maps to the WASM `anyref` type.

### Type Inference

Local variable types are inferred from their initializer expression.

```zena
let x = 10; // Inferred as i32
let s = 'hello'; // Inferred as string
```

### Type Casting

Zena enforces strict type safety and does not support implicit type coercion.

Explicit type casts (e.g., using an `as` operator) are **checked casts**. This means the validity of the cast is verified at runtime. If the value is not of the target type, a runtime error (trap) is raised. This ensures that the type system remains sound even when downcasting.

**Numeric Conversions**:
Conversions between numeric types (e.g., `i32` to `i64`, `f32` to `i32`) generally must be explicit. These casts compile to specific WASM conversion instructions (e.g., `i64.extend_i32_s`, `i32.trunc_f32_s`).

- `i32` <-> `i64` (Sign-extend / Wrap)
- `i32` <-> `f32` (Convert / Truncate)
- `i64` <-> `f64` (Convert / Truncate)
- `i32` <-> `u32` (Reinterpret bits - zero cost)

**Implicit Conversions**:
Zena supports implicit conversion **only** between `i32` and `f32` in binary arithmetic operations.

- `i32` + `f32` -> `f32` (The `i32` is promoted to `f32`)
- `f32` + `i32` -> `f32`

All other mixed arithmetic (e.g., `i32` + `i64`, `f32` + `f64`) requires explicit casting.

However, if the source type and the target type are identical (e.g. casting a value to its own type, or casting between a distinct type and its underlying type), the cast is **elided** at runtime. In these cases, the cast serves purely as a compile-time assertion and incurs no runtime overhead.

```zena
distinct type ID = i32;
let id = 1 as ID; // Checked at compile time, elided at runtime
```

### Type Aliases

Type aliases create a new name for a type. They are defined using the `type` keyword.

```zena
type ID = string;
type Point = {x: i32; y: i32};
type Callback = (result: string) => void;
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

Distinct types create a new type that is structurally identical to an existing type but treated as a unique type by the type checker. This is useful for creating type-safe identifiers or units of measure.

```zena
distinct type Meters = i32;
distinct type Seconds = i32;

let m: Meters = 10 as Meters;
let s: Seconds = 20 as Seconds;

// let x = m + s; // Error: Type mismatch
```

Distinct types are erased at runtime, so they have no performance overhead. Casting between a distinct type and its underlying type is a zero-cost operation.

### Function Types

Function types describe the signature of a function. They are written using arrow syntax.

```zena
type BinaryOp = (a: i32, b: i32) => i32;
type Callback = () => void;

let add: BinaryOp = (a, b) => a + b;
```

### Union Types

Union types describe a value that can be one of several types. They are written using the `|` operator.

```zena
let x: string | null = null;
x = 'hello';
```

#### Constraints

Union types in Zena are restricted to **Reference Types**. You cannot create a union containing a value primitive (`i32`, `f32`, `boolean`).

- **Valid**: `string | null`, `MyClass | MyInterface`, `array<i32> | null`.
- **Invalid**: `i32 | null`, `boolean | string`.

This restriction exists because value primitives in WASM have a different memory representation (stack/value) than reference types (heap/pointer). Mixing them in a single variable would require implicit boxing or a tagged union representation, which Zena avoids for performance and simplicity.

To use a primitive in a union (e.g., for a nullable integer), you must wrap it in a `Box<T>`.

```zena
import {Box} from 'zena';

let maybeNumber: Box<i32> | null = new Box(42);
```

**Note**: This is distinct from the "Indistinguishable Types" limitation (see [Distinguishable Types & Erasure](#distinguishable-types--erasure)). Primitives _are_ distinguishable from references, but they are incompatible in storage layout.

#### Type Narrowing

Zena supports **control-flow-based type narrowing** for union types. When you check whether a variable is or isn't `null`, or use the `is` operator, the type system automatically narrows the variable's type within the respective branches.

##### Null Checks

```zena
class Node {
  value: i32;
  next: Node | null;

  #new(value: i32) {
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

- `x !== null` / `x != null`: Narrows `x` to non-null in the true branch, to `null` in the else branch.
- `null !== x` / `null != x`: Same as above.
- `x === null` / `x == null`: Narrows `x` to `null` in the true branch, to non-null in the else branch.
- `null === x` / `null == x`: Same as above.

##### Type Checks with `is`

The `is` operator narrows the type to the checked type in the true branch, and removes that type in the else branch (for unions):

```zena
class Cat {
  #new() {}
  meow(): string { return "meow"; }
}

class Dog {
  #new() {}
  bark(): string { return "woof"; }
}

let speak = (pet: Cat | Dog): string => {
  if (pet is Cat) {
    // pet is narrowed to Cat
    return pet.meow();
  } else {
    // pet is narrowed to Dog (Cat removed from union)
    return pet.bark();
  }
};
```

Type narrowing is scoped to the block where the narrowing applies. Once you exit the block, the original type is restored.

### Literal Types

Zena supports **literal types** for strings, numbers, and booleans. A literal type represents a single, specific value rather than a general type. Literal types are especially useful in union types to create enumerations of specific values.

```zena
// String literal types
type Mode = 'replace' | 'append' | 'insert';
let mode: Mode = 'replace';

// Number literal types
type Level = 1 | 2 | 3;
let level: Level = 2;

// Boolean literal types
type Flag = true | false;  // Equivalent to boolean, but more explicit
let flag: Flag = true;
```

Literal types are checked at compile time and allow precise type constraints:

```zena
let setMode = (mode: 'read' | 'write') => {
  // mode is guaranteed to be exactly 'read' or 'write'
};

setMode('read');    // OK
setMode('append');  // Error: Type '"append"' is not assignable to type '"read" | "write"'
```

**Key points:**

- Literal types are **singleton types** - they represent exactly one value.
- Unlike regular primitive types, literal types **can be used in unions** because they are distinguishable at runtime.
- A literal value is assignable to its literal type and to the corresponding base type (e.g., `'hello'` is assignable to both `'hello'` and `string`).
- Literal types enable precise API contracts and exhaustive pattern matching.

## 3. Variables

Variables are declared using `let` or `var`.

- **`let`**: Declares a block-scoped immutable binding.
- **`var`**: Declares a block-scoped mutable binding.

### Syntax

```zena
let name = expression;
var name = expression;
```

### Scoping

Variables declared with `let` and `var` are block-scoped. Redeclaring a variable in the same scope is a compile-time error.

## 4. Functions

Zena currently supports functions using arrow syntax.

### Syntax

```zena
(param1: Type, param2: Type) => expression;
```

### Parameters

Function parameters must have explicit type annotations.

```zena
let add = (a: i32, b: i32) => a + b;
```

### Return Type

The return type is inferred from the body expression. It can also be explicitly annotated.

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

### Closures

Functions in Zena are closures. They can capture variables from their surrounding scope. Captured variables are stored in a heap-allocated context, ensuring they remain available even after the outer scope has returned.

```zena
let makeAdder = (x: i32) => {
  return (y: i32) => x + y;
};

let add5 = makeAdder(5);
let result = add5(10); // 15
```

### Generic Functions

Functions can be generic by specifying type parameters before the parameter list:

```zena
let identity = <T>(x: T): T => x;

let num = identity<i32>(42);
let str = identity<string>('hello');
```

Generic type parameters can be constrained:

```zena
class Printable {
  toString(): string {
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

Zena supports passing functions with fewer arguments than expected by the receiver. The compiler automatically generates an adapter to bridge the difference. This applies to function arguments, variable assignments, and union type matching.

```zena
// Function expecting a callback with 3 arguments
let map = (fn: (item: i32, index: i32, array: MyArray) => i32) => { ... };

// You can pass a callback that uses fewer arguments
map((item) => item * 2); // Ignores index and array
map((item, index) => item + index); // Ignores array

// Assignment to Union Type
type Handler = (a: i32, b: i32) => void;

// Target is Union: Handler | string
// Provided: (a: i32) => void
// Result: Adapts to Handler
let h: Handler | string = (a: i32) => {};

```

This adaptation incurs a small performance overhead (allocation of a wrapper closure) and is only applied when the arity mismatch is detected at compile time.

### Optional Parameters

Function parameters can be marked as optional using `?`. Optional parameters must come after required parameters.

When a parameter is optional and has no default value, its type becomes a union with `null` (e.g., `T | null`). Because unions cannot contain primitive types, **optional primitive parameters must have a default value** or be wrapped in `Box<T>`.

```zena
// ✅ Valid: Reference type (string | null)
let greet = (name?: string) => { ... };

// ✅ Valid: Primitive with default value (type is i32)
let increment = (amount: i32 = 1) => { ... };

// ✅ Valid: Boxed primitive (Box<i32> | null)
let process = (val?: Box<i32>) => { ... };

// ❌ Invalid: Primitive without default (would be i32 | null)
// let invalid = (amount?: i32) => { ... };
```

```zena
let greet = (name: string, greeting?: string) => {
  // greeting is inferred as string | null
  if (greeting == null) {
    return `Hello, ${name}`;
  }
  return `${greeting}, ${name}`;
};

greet('Alice'); // "Hello, Alice"
greet('Bob', 'Hi'); // "Hi, Bob"
```

Optional parameters can also have default values.

```zena
let increment = (x: i32, amount: i32 = 1) => x + amount;

increment(10); // 11
increment(10, 5); // 15
```

When a default value is provided, the parameter type in the function body is the non-nullable type (unless the default value itself is null).

### Calling Union Types

Zena supports calling a function that is typed as a Union of function types, even if those functions have different arities. The compiler generates a runtime dispatch that checks the actual type of the function and calls it with the appropriate number of arguments. Extra arguments are ignored if the runtime function expects fewer.

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

Zena supports function overloading for declared external functions. This allows you to define multiple signatures for the same function name, provided they have different parameter lists.

```zena
declare function print(val: i32): void;
declare function print(val: f32): void;

print(42); // Calls print(i32)
print(3.14); // Calls print(f32)
```

Overload resolution is performed based on the argument types at the call site.

## 5. Expressions & Operators

### Literals

- **Numbers**: `123`, `0`, `-5`, `0x1A`, `0xFF` (Parsed as `i32` by default).
- **Strings**: `"text"` or `'text'`.
- **Template Literals**: `` `text ${expression}` `` (Backtick-delimited with interpolation).

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

**Note**: Unicode escape sequences (e.g., `\uXXXX`) are not currently supported. Since Zena source files are UTF-8, you can include Unicode characters directly in the string.

### Strings

Strings are immutable sequences of characters.

- **Literals**: `'text'` or `"text"`.
- **Concatenation**: `+` operator.
- **Length**: `str.length` returns the length of the string.
- **Indexing**: Direct indexed access (`str[index]`) is **not supported**. Use
  iterators or methods like `charAt()` (planned) to access characters.

### Template Literals

Template literals are backtick-delimited strings that support embedded expressions and preserve raw string content.

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

Tagged templates allow custom processing of template literals by preceding them with a tag function:

```zena
let tag = (strings: Array<String>, values: Array<i32>): String => {
  // strings: array of string literals between expressions
  // values: array of evaluated expressions
  return strings[0];
};

let result = tag`Hello ${42} World`;
```

The tag function receives:

1. **strings**: An array of the literal string parts. This array has a `raw` property containing the original source strings (before escape processing).
2. **values**: An array of the interpolated expression values.

The strings array length is always `values.length + 1`.

**Note**: The strings array maintains identity across evaluations of the same template expression, allowing it to be used as a cache key for expensive one-time processing.

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

- `+` (Addition / String Concatenation)
- `-` (Subtraction)
- `*` (Multiplication)
- `/` (Division) - Always returns a floating-point value (`f32` or `f64`).
- `%` (Modulo - integer types only) - Signed for `i32`, unsigned for `u32`.

Supported bitwise operators for integer types (`i32`, `u32`):

- `&` (Bitwise AND)
- `|` (Bitwise OR)
- `^` (Bitwise XOR)

Operands must be of the same type, with the exception of mixing `i32` and `f32`. **Mixing other numeric types (e.g., `i32` and `i64`) is not allowed**; you must explicitly cast using `as`.

```zena
let a = 10;
let b = 20;
let c = a + b; // Valid
let s = 'Hello' + ' World'; // Valid (String Concatenation)
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

### Grouping

Parentheses `( )` can be used to group expressions and control precedence.

```zena
let result = (1 + 2) * 3;
```

### Comparison Operators

- `==` (Equal) - Supports value equality for strings.
- `!=` (Not Equal) - Supports value equality for strings.
- `===` (Strict Equal) - Checks for reference equality, bypassing custom `operator ==`.
- `!==` (Strict Not Equal) - Checks for reference inequality, bypassing custom `operator ==`.
- `<` (Less Than) - Signed comparison for `i32`, unsigned for `u32`.
- `<=` (Less Than or Equal) - Signed comparison for `i32`, unsigned for `u32`.
- `>` (Greater Than) - Signed comparison for `i32`, unsigned for `u32`.
- `>=` (Greater Than or Equal) - Signed comparison for `i32`, unsigned for `u32`.

These operators return a boolean value. **Comparing `i32` and `u32` directly is not allowed**; cast one to the other first.

### Logical Operators

- `&&` (Logical AND) - Short-circuiting AND. Returns `true` if both operands are `true`.
- `||` (Logical OR) - Short-circuiting OR. Returns `true` if at least one operand is `true`.

Operands must be of type `boolean`.

## 6. Control Flow

### Optional Semicolons

Semicolons are generally required to terminate statements. However, for block-ended expressions (`if`, `match`, `try`) used as standalone statements, the trailing semicolon is optional.

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

**Note**: When these expressions are used as part of another statement (e.g., variable declaration, return statement), the semicolon is still required.

```zena
// Required semicolon
let x = if (cond) 1 else 2;
return match (x) { ... };
```

### Blocks

A block statement groups zero or more statements within curly braces `{}`. Blocks introduce a new **lexical scope**. Variables declared within a block are only accessible within that block and any nested blocks.

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

Like Rust, Zena's `if/else` can be used as an expression. Each block evaluates to the value of its last expression. When used as an expression, the `else` clause is required.

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

### For Statement

Zena supports C-style `for` loops. The loop variable must be declared with `var` since it is mutable.

```zena
for (var i = 0; i < 10; i = i + 1) {
  // body
}
```

The `for` statement consists of three optional parts:

- **init**: A variable declaration or expression, executed once before the loop starts.
- **test**: A boolean expression evaluated before each iteration. If false, the loop exits.
- **update**: An expression executed after each iteration.

Any of these parts can be omitted:

```zena
// Infinite loop (test omitted)
for (;;) {
  // Use return to exit
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

- **Identifiers**: Bind the matched value to a variable.

  ```zena
  case x: x + 1
  ```

- **Wildcard**: `_` matches any value without binding.

  ```zena
  case _: ...
  ```

- **Class Patterns**: Match class instances and destructure fields.

  ```zena
  case Point { x: 0, y }: ... // Matches Point with x=0, binds y
  ```

- **Record Patterns**: Match records and destructure fields.

  ```zena
  case { a: 1, b }: ...
  ```

- **Tuple Patterns**: Match tuples and destructure elements.

  ```zena
  case [1, x]: ...
  ```

- **Logical Patterns**: Combine patterns using `|` (OR) and `&` (AND).

  ```zena
  case 1 | 2: ... // Matches 1 or 2
  case Point { x } & { y }: ... // Matches Point and binds x and y
  ```

Patterns can be nested.

```zena
case Point { x: 0, y: [1, z] }: ...
```

#### Guard Patterns

Match cases can include an optional guard expression using `if`. The guard is a boolean expression that must evaluate to `true` for the case to match. The guard can reference variables bound in the pattern.

```zena
match (x) {
  case i if i > 10: "greater than 10"
  case i if i < 0: "negative"
    case _: "between 0 and 10"
}
```

#### Block Cases

Match cases can contain a block of statements. The value of the block is the value of the last expression.

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

You can use a wildcard pattern `_` or a variable pattern to cover all remaining cases.

```zena
match (x) {
  case 1: "one"
  case _: "other"
}
```

The compiler also checks for unreachable cases. If a case appears after a pattern that covers all remaining possibilities (like a wildcard), it is flagged as unreachable.

## 7. Classes and Objects

Zena supports object-oriented programming with classes.

### Class Declaration

Classes are declared using the `class` keyword.

````zena
class Point {
  x: i32;
  y: i32;

  #new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  move(dx: i32, dy: i32) {
    this.x = this.x + dx;
    this.y = this.y + dy;
  }
}

### Generic Classes

Classes can be generic by specifying type parameters:

```zena
class Box<T> {
  value: T;

  #new(value: T) {
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
  name: string;
  #new(name: string) {
    this.name = name;
  }
}

class Zoo<T extends Animal> {
  animals: array<T>;

  #new() {
    this.animals = #[];
  }
}
```

Multiple type parameters can have constraints that reference other type parameters:

```zena
class Container<T extends Box<V>, V> {
  item: T;

  #new(item: T) {
    this.item = item;
  }
}
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
````

Generic methods can be called with explicit type arguments or inferred.

```zena
let c = new Container();
c.value = 10;
let s = c.map<string>((v) => 'Value: ' + v); // Explicit
let n = c.map((v) => v * 2); // Inferred
```

### Method Overloading

Zena supports method overloading, allowing multiple methods with the same name but different parameter types or counts.

```zena
class Printer {
  print(val: i32): void {
    console.log('i32: ' + val);
  }

  print(val: f32): void {
    console.log('f32: ' + val);
  }

  print(val: string): void {
    console.log('string: ' + val);
  }
}

let p = new Printer();
p.print(42);      // Calls print(i32)
p.print(3.14);    // Calls print(f32)
p.print('hello'); // Calls print(string)
```

The compiler resolves the correct overload based on argument types at compile time.

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

Overloading also works with operator methods:

```zena
class MultiMap {
  data: Map<i32, string>;

  operator [](key: i32): string {
    return this.data.get(key);
  }

  operator [](key: string): string {
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

- **Fields**: Declared with a type annotation.
- **Constructor**: Named `#new`.
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
- **`declare` fields**: Extension classes can declare fields that exist on the underlying type but are not implemented in the extension (e.g., for intrinsics).

```zena
export final extension class FixedArray<T> on array<T> {
  @intrinsic('array.len')
  declare length: i32;
}
```

### Static Symbols

Static Symbols allow you to define unique identifiers for methods and fields that are distinct from string names. This is useful for defining "protocol" methods (like iterators) or internal APIs that should not collide with public members.

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

To define or call a method using a symbol, use the bracket syntax `[symbol]`.

```zena
class MyList<T> implements Iterable<T> {
  // Implementation
  [Iterable.iterator](): Iterator<T> {
    // ...
  }
}

let list = new MyList();
let it = list[Iterable.iterator]();
```

#### Semantics

- **Compile-Time Resolution**: Symbols are resolved at compile time. The expression inside `[...]` must be a constant expression that resolves to a symbol.
- **No Collisions**: Two interfaces can define methods with the same _name_ but different _symbols_, allowing a class to implement both without conflict.
- **Access Control**: Visibility is controlled via standard `export` rules. If a symbol is not exported, it cannot be used outside the module.

### Distinguishable Types & Erasure

Zena uses **type erasure** for certain constructs to maintain zero-cost abstractions. This means that some types which are distinct at compile time are identical at runtime.

Types that are identical at runtime are considered **indistinguishable**. This has implications for:

- **Union Types**: A union cannot contain multiple types that are indistinguishable from each other.
- **Pattern Matching**: You cannot match against multiple indistinguishable types in the same `match` expression (as the first case would always match).
- **`is` Checks**: Checking if a value `is T` where `T` is an erased type will check against the underlying runtime type.

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
    distinct type IdA = string;
    distinct type IdB = string;
    // IdA and IdB are both string at runtime.
    ```

3.  **Generic Instantiations of Erased Types**:
    ```zena
    // Box<T> is monomorphized, but if T erases to the same type, Box<T> might be the same struct.
    // Currently, Box<Meters> and Box<Seconds> (where Meters/Seconds are i32) are indistinguishable.
    ```

#### Valid Distinguishable Types

- **Classes**: `class A {}` and `class B {}` are always distinguishable.
- **Reified Generics**: `Box<i32>` and `Box<string>` are distinguishable because `i32` and `string` have different runtime representations.
- **Primitives**: `i32` and `string` are distinguishable.

### Limitations

Since extension classes and distinct types are erased at runtime, they have some limitations:

1.  **Unions**: You cannot create a union type containing multiple extension classes or distinct types that extend the same underlying type.

    ```zena
    extension class A on array<i32> {}
    extension class B on array<i32> {}

    let x: A | B; // Error: Ambiguous union
    ```

2.  **Pattern Matching**: You cannot have multiple cases in a `match` expression that match against extension classes on the same underlying type.
    ```zena
    match (arr) {
      case A {}: ...
    ```

## 8. Enums

Enums allow you to define a set of named constants. Zena enums are nominal types that wrap a union of literal values.

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

An enum declaration creates:

1.  A **Distinct Type** named `Color` which is a union of the member values (e.g., `0 | 1 | 2`).
2.  A **Runtime Object** named `Color` containing the members as properties.

```zena
let c: Color = Color.Red;
```

### Backing Types

Enums can be backed by integers (`i32`) or strings.

- **Integer Enums**: If no initializer is provided, values start at 0 and increment by 1.
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

Enums are **distinct types**, meaning they are not assignable to or from their underlying primitive types without an explicit cast.

```zena
let c: Color = Color.Red;

// Error: Type 'i32' is not assignable to type 'Color'.
// let x: Color = 0;

// Error: Type 'Color' is not assignable to type 'i32'.
// let y: i32 = c;

// Explicit casting is allowed
let z: i32 = c as i32;
```

Because the Enum type is defined as a union of its member values (e.g., `0 | 1 | 2`), the type checker enforces that variables of the Enum type can only hold one of the valid member values (within the limits of compile-time analysis).

### Built-in Types

#### `array<T>`

Zena provides a low-level built-in array type `array<T>`. This maps directly to WASM GC arrays.

- **Creation**: `__array_new(length, default_value)` (Intrinsic) or via `FixedArray` wrapper.
- **Indexing**: `arr[index]`
- **Length**: `arr.length` (via extension)

## 7. Data Structures

### Records

Records are immutable, structural types that hold a fixed set of named fields.

```zena
let p = { x: 1, y: 2 };
let x = p.x;
```

#### Shorthand Syntax

If a variable name matches the field name, you can use the shorthand syntax:

```zena
let x = 1;
let y = 2;
let p = { x, y }; // Equivalent to { x: x, y: y }
```

#### Spread Syntax

You can use the spread syntax (`...`) to copy properties from another record into a new record.

```zena
let p = { x: 1, y: 2 };
let p3 = { ...p, z: 3 }; // { x: 1, y: 2, z: 3 }
```

The spread syntax produces the same keys that are available for destructuring. If a property is defined multiple times (e.g., via spread and explicit assignment), the last definition wins.

```zena
let p = { x: 1, y: 2 };
let p2 = { ...p, x: 10 }; // { x: 10, y: 2 }
```

### Tuples

Tuples are immutable, structural types that hold a fixed sequence of typed elements.

```zena
let t = [1, "hello"];
let n = t[0];
```

## 8. Modules & Exports

### Exports

Top-level declarations (variables, functions, classes) can be exported using the `export` keyword. This exposes them to the host environment.

```zena
// Export a function
export let add = (a: i32, b: i32) => a + b;

// Export a class
export class Point {
  x: i32;
  y: i32;
  #new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }
}
```

### Imports (Host Interop)

Zena allows importing functions from the host environment using the `declare` keyword and the `@external` decorator.

```zena
@external("env", "log")
declare function log(val: i32): void;
```

- **`@external(module, name)`**: Specifies the WASM import module and name.
- **`declare function`**: Defines the function signature. The function body is omitted.

These declarations map to WebAssembly imports, allowing Zena to call JavaScript functions (or other WASM modules).

### Exports

Top-level declarations can be exported using the `export` keyword. This exposes them to other modules or the host environment.

```zena
export let add = (a: i32, b: i32) => a + b;
export declare function print(s: string): void;
export class Point { ... }
```

## 9. Intrinsics

Intrinsics are special functions that map directly to compiler-generated code or WebAssembly instructions. They are primarily used to implement the standard library and low-level primitives.

Intrinsics are declared using the `@intrinsic` decorator on a `declare function` statement.

### Equality Intrinsic (`eq`)

The `eq` intrinsic provides a generic equality check that works across all types.

```zena
@intrinsic('eq')
declare function equals<T>(a: T, b: T): boolean;
```

The behavior depends on the type `T`:

- **Primitives (`i32`, `f32`, `boolean`)**: Performs value equality.
- **Strings**: Performs value equality (byte-wise comparison).
- **Reference Types (Classes, Arrays, Records)**:
  - By default, performs **reference equality** (checks if both operands refer to the same object).
  - If the type implements `operator ==`, the intrinsic performs a **virtual method call** to that operator.

#### Custom Equality with `operator ==`

Classes can customize equality behavior by implementing `operator ==`.

```zena
class Point {
  x: i32;
  y: i32;

  #new(x: i32, y: i32) {
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

The `hash` intrinsic computes a hash code for a value, suitable for use in hash maps.

```zena
@intrinsic('hash')
declare function hash<T>(val: T): i32;
```

The behavior depends on the type `T`:

- **Primitives (`i32`, `boolean`)**: Returns the value itself (or 1/0 for boolean).
- **Strings**: Computes the FNV-1a hash of the string bytes.
- **Classes**:
  - If the class implements a `hashCode(): i32` method, it is called.
  - Otherwise, returns 0 (fallback).

## 10. Standard Library

Zena includes a small standard library of utility classes. These are automatically imported into every module.

### Map<K, V>

A mutable hash map implementation.

**Note**: Because `Map` accessors return `V | null` to indicate missing keys, the value type `V` must be a reference type. Primitive types (like `i32`) cannot be used directly because they cannot form a union with `null` (see [Union Types](#union-types)). To store primitives, wrap them in `Box<T>`.

```zena
let map = new Map<string, Box<i32>>();
map.set('one', new Box(1));
map['two'] = new Box(2);

let val = map['one']; // Returns Box<i32> | null
```

### Box<T>

A wrapper class for holding values. This is particularly useful for using primitive types in contexts that require reference types, such as Union Types.

```zena
let b = new Box(42);
let val: Box<i32> | null = b;
```

## 11. Exception Handling

Zena supports throwing exceptions using the `throw` keyword.

### Throw Expression

The `throw` expression interrupts execution and unwinds the stack. It evaluates to the `never` type, meaning it can be used in any context where a value is expected.

```zena
throw new Error("Something went wrong");

let x: i32 = throw new Error("Boom"); // Valid, x is never assigned
```

The expression thrown must be an instance of the `Error` class (or a subclass).

### Error Class

The `Error` class is part of the standard library and is available globally.

```zena
class Error {
  message: string;
  #new(message: string) { this.message = message; }
}
```

## 12. Enums

Enums allow you to define a set of named constants. In Zena, enums are nominal types backed by `i32` values.

```zena
enum Color {
  Red,
  Green,
  Blue
}

let c: Color = Color.Red;
```

### Backing Values

By default, enum members are assigned integer values starting from 0. You can manually specify values.

```zena
enum Status {
  Ok = 200,
  NotFound = 404,
  Error = 500
}
```

### Usage

Enums are treated as distinct types. You cannot assign an integer directly to an enum variable without casting, nor can you assign an enum to an integer variable without casting.

```zena
let s: Status = Status.Ok;
let code: i32 = s as i32; // Explicit cast required
```

## 14. Grammar (Simplified)

```ebnf
Module ::= Statement*

Statement ::= ExportStatement | VariableDeclaration | ExpressionStatement | BlockStatement | ReturnStatement | IfStatement | WhileStatement | ForStatement

ExportStatement ::= "export" (VariableDeclaration | ClassDeclaration | InterfaceDeclaration | MixinDeclaration | DeclareFunction)

VariableDeclaration ::= ("let" | "var") Identifier "=" Expression ";"

ExpressionStatement ::= Expression ";"

BlockStatement ::= "{" Statement* "}"

ReturnStatement ::= "return" Expression? ";"

IfStatement ::= "if" "(" Expression ")" Statement ("else" Statement)?

WhileStatement ::= "while" "(" Expression ")" Statement

ForStatement ::= "for" "(" ForInit? ";" Expression? ";" Expression? ")" Statement

ForInit ::= VariableDeclaration | Expression

Expression ::= ArrowFunction | AssignmentExpression | BinaryExpression | CallExpression | NewExpression | MemberExpression | ArrayLiteral | IndexExpression | TemplateLiteral | TaggedTemplateExpression | ThrowExpression | UnaryExpression

AssignmentExpression ::= (Identifier | MemberExpression | IndexExpression) "=" Expression

CallExpression ::= Expression "(" (Expression ("," Expression)*)? ")"

NewExpression ::= "new" Identifier "(" (Expression ("," Expression)*)? ")"

MemberExpression ::= Expression "." Identifier

ArrayLiteral ::= "#[" (Expression ("," Expression)*)? "]"

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
let t = [10, 20];
let [a, b] = t;
let [first, , third] = [1, 2, 3]; // Skipping elements
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
