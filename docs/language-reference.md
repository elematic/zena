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

- **`i32`**: 32-bit signed integer. This is the default type for integer literals.
- **`f32`**: 32-bit floating-point number.
- **`boolean`**: Boolean value (`true` or `false`).
- **`string`**: UTF-8 string.
- **`anyref`**: The top type for all reference types. It can hold any object, array, string, function, or `null`. It cannot hold unboxed primitives (`i32`, `f32`, `boolean`).
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

This restriction exists because value primitives in WASM do not carry runtime type information and cannot be mixed with references without explicit boxing.

To use a primitive in a union (e.g., for a nullable integer), you must wrap it in a `Box<T>`.

```zena
import {Box} from 'zena';

let maybeNumber: Box<i32> | null = new Box(42);
```

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

### Strings

Strings are immutable sequences of UTF-8 bytes.

- **Literals**: `'text'` or `"text"`.
- **Concatenation**: `+` operator.
- **Indexing**: `str[index]` returns the byte value at the given index as an `i32`.
- **Length**: `str.length` returns the number of bytes.

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

Supported arithmetic operators for numeric types (`i32`, `f32`):

- `+` (Addition / String Concatenation)
- `-` (Subtraction)
- `*` (Multiplication)
- `/` (Division)
- `%` (Modulo - `i32` only)

Supported bitwise operators for integer types (`i32`):

- `&` (Bitwise AND)
- `|` (Bitwise OR)
- `^` (Bitwise XOR)

Operands must be of the same type. Implicit coercion is not supported.

```zena
let a = 10;
let b = 20;
let c = a + b; // Valid
let s = 'Hello' + ' World'; // Valid (String Concatenation)
// let d = a + "string"; // Error: Type mismatch
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
- `<` (Less Than)
- `<=` (Less Than or Equal)
- `>` (Greater Than)
- `>=` (Greater Than or Equal)

These operators return a boolean value.

### Logical Operators

- `&&` (Logical AND) - Short-circuiting AND. Returns `true` if both operands are `true`.
- `||` (Logical OR) - Short-circuiting OR. Returns `true` if at least one operand is `true`.

Operands must be of type `boolean`.

## 6. Control Flow

### If Statement

Zena supports `if` and `else` for conditional execution.

```zena
if (condition) {
  // consequent
} else {
  // alternate
}
```

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

### Built-in Types

#### `array<T>`

Zena provides a low-level built-in array type `array<T>`. This maps directly to WASM GC arrays.

- **Creation**: `__array_new(length, default_value)` (Intrinsic) or via `FixedArray` wrapper.
- **Indexing**: `arr[index]`
- **Length**: `arr.length` (via extension)

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

Zena includes a small standard library of utility classes. These are automatically imported into every program.

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

## 14. Grammar (Simplified)

```ebnf
Program ::= Statement*

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
