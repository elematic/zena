# Zena Language Reference

This document describes the syntax and semantics of the Zena programming language.

## 1. Introduction

Zena is a statically typed language targeting WebAssembly (WASM-GC). It features a TypeScript-like syntax with strict static typing and no implicit coercion.

## 1.1 Comments

Zena supports two styles of comments:

### Single-Line Comments

Single-line comments begin with `//` and continue to the end of the line.

```typescript
let x = 1; // This is a single-line comment
```

### Multi-Line Comments

Multi-line comments begin with `/*` and end with `*/`. They can span multiple lines.

```typescript
/* This is a
   multi-line comment */
let x = 1;

let y /* inline comment */ = 2;
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
- **`ByteArray`**: A mutable array of 8-bit integers. This is a low-level type primarily used for implementing strings and binary data manipulation.

### Type Inference

Local variable types are inferred from their initializer expression.

```typescript
let x = 10; // Inferred as i32
let s = 'hello'; // Inferred as string
```

### Type Casting

Zena enforces strict type safety and does not support implicit type coercion.

Explicit type casts (e.g., using an `as` operator) are **checked casts**. This means the validity of the cast is verified at runtime. If the value is not of the target type, a runtime error (trap) is raised. This ensures that the type system remains sound even when downcasting.

## 3. Variables

Variables are declared using `let` or `var`.

- **`let`**: Declares a block-scoped immutable binding.
- **`var`**: Declares a block-scoped mutable binding.

### Syntax

```typescript
let name = expression;
var name = expression;
```

### Scoping

Variables declared with `let` and `var` are block-scoped. Redeclaring a variable in the same scope is a compile-time error.

## 4. Functions

Zena currently supports functions using arrow syntax.

### Syntax

```typescript
(param1: Type, param2: Type) => expression;
```

### Parameters

Function parameters must have explicit type annotations.

```typescript
const add = (a: i32, b: i32) => a + b;
```

### Return Type

The return type is inferred from the body expression. It can also be explicitly annotated.

```typescript
const add = (a: i32, b: i32): i32 => a + b;
```

### Function Body

Function bodies can be a single expression or a block statement.

```typescript
// Expression body
let add = (a: i32, b: i32) => a + b;

// Block body
let add = (a: i32, b: i32) => {
  return a + b;
};
```

### Function Overloading

Zena supports function overloading for declared external functions. This allows you to define multiple signatures for the same function name, provided they have different parameter lists.

```typescript
declare function print(val: i32): void;
declare function print(val: f32): void;

print(42); // Calls print(i32)
print(3.14); // Calls print(f32)
```

Overload resolution is performed based on the argument types at the call site.

## 5. Expressions & Operators

### Literals

- **Numbers**: `123`, `0`, `-5` (Parsed as `i32` by default).
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

```typescript
let message = 'Hello\nWorld'; // Contains a newline
let path = 'C:\\Users\\file'; // Escaped backslashes
let quote = 'She said "Hi"'; // Escaped double quotes
let apostrophe = "it's"; // Escaped single quote
```

### Template Literals

Template literals are backtick-delimited strings that support embedded expressions and preserve raw string content.

#### Basic Template Literals

```typescript
let greeting = `Hello, World!`;
let multiline = `Line 1
Line 2`;
```

#### String Interpolation

Expressions can be embedded using `${}`:

```typescript
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

```typescript
let code = `Use \`backticks\` for templates`;
let price = `Cost: \$100`; // Prevents ${} interpolation
```

#### Tagged Template Literals

Tagged templates allow custom processing of template literals by preceding them with a tag function:

```typescript
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

```typescript
// Example: SQL query builder
let sql = (strings: Array<String>, values: Array<i32>): String => {
  // Build parameterized query from strings
  // Use values for parameters
  return strings[0];
};

let userId = 123;
let query = sql`SELECT * FROM users WHERE id = ${userId}`;
```

### Binary Operators

Supported arithmetic operators for numeric types (`i32`, `f32`):

- `+` (Addition / String Concatenation)
- `-` (Subtraction)
- `*` (Multiplication)
- `/` (Division)

Operands must be of the same type. Implicit coercion is not supported.

```typescript
let a = 10;
let b = 20;
let c = a + b; // Valid
let s = 'Hello' + ' World'; // Valid (String Concatenation)
// let d = a + "string"; // Error: Type mismatch
```

### Function Calls

Functions can be called using parentheses `()`.

```typescript
let result = add(1, 2);
```

### Assignment

Mutable variables (declared with `var`) can be reassigned.

```typescript
var x = 1;
x = 2;
```

### Grouping

Parentheses `( )` can be used to group expressions and control precedence.

```typescript
let result = (1 + 2) * 3;
```

### Comparison Operators

- `==` (Equal) - Supports value equality for strings.
- `!=` (Not Equal) - Supports value equality for strings.
- `<` (Less Than)
- `<=` (Less Than or Equal)
- `>` (Greater Than)
- `>=` (Greater Than or Equal)

These operators return a boolean value.

## 6. Control Flow

### If Statement

Zena supports `if` and `else` for conditional execution.

```typescript
if (condition) {
  // consequent
} else {
  // alternate
}
```

### While Statement

Zena supports `while` loops.

```typescript
while (condition) {
  // body
}
```

### For Statement

Zena supports C-style `for` loops. The loop variable must be declared with `var` since it is mutable.

```typescript
for (var i = 0; i < 10; i = i + 1) {
  // body
}
```

The `for` statement consists of three optional parts:

- **init**: A variable declaration or expression, executed once before the loop starts.
- **test**: A boolean expression evaluated before each iteration. If false, the loop exits.
- **update**: An expression executed after each iteration.

Any of these parts can be omitted:

```typescript
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

## 7. Modules & Exports

### Exports

Top-level declarations (variables, functions, classes) can be exported using the `export` keyword. This exposes them to the host environment.

```typescript
// Export a function
export const add = (a: i32, b: i32) => a + b;

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

```typescript
@external("env", "log")
declare function log(val: i32): void;
```

- **`@external(module, name)`**: Specifies the WASM import module and name.
- **`declare function`**: Defines the function signature. The function body is omitted.

These declarations map to WebAssembly imports, allowing Zena to call JavaScript functions (or other WASM modules).

### Exports

Top-level declarations can be exported using the `export` keyword. This exposes them to other modules or the host environment.

```typescript
export const add = (a: i32, b: i32) => a + b;
export declare function print(s: string): void;
export class Point { ... }
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

Expression ::= ArrowFunction | AssignmentExpression | BinaryExpression | CallExpression | NewExpression | MemberExpression | ArrayLiteral | IndexExpression | TemplateLiteral | TaggedTemplateExpression

AssignmentExpression ::= (Identifier | MemberExpression | IndexExpression) "=" Expression

CallExpression ::= Expression "(" (Expression ("," Expression)*)? ")"

NewExpression ::= "new" Identifier "(" (Expression ("," Expression)*)? ")"

MemberExpression ::= Expression "." Identifier

ArrayLiteral ::= "#[" (Expression ("," Expression)*)? "]"

IndexExpression ::= Expression "[" Expression "]"

TemplateLiteral ::= "`" TemplateSpan* "`"

TemplateSpan ::= TemplateChars | "${" Expression "}"

TaggedTemplateExpression ::= Expression TemplateLiteral

ArrowFunction ::= "(" ParameterList? ")" (":" TypeAnnotation)? "=>" Expression

ParameterList ::= Parameter ("," Parameter)*

Parameter ::= Identifier ":" TypeAnnotation

BinaryExpression ::= PrimaryExpression (Operator PrimaryExpression)*

PrimaryExpression ::= NumberLiteral | StringLiteral | Identifier | "(" Expression ")"

Operator ::= "+" | "-" | "*" | "/"
```

### Destructuring

Zena supports destructuring for Records, Tuples, and Classes.

#### Record Destructuring

```typescript
let p = { x: 10, y: 20 };
let { x, y } = p;
let { x as a, y as b } = p; // Renaming
```

#### Tuple Destructuring

```typescript
let t = [10, 20];
let [a, b] = t;
let [first, , third] = [1, 2, 3]; // Skipping elements
```

#### Class Destructuring

Class instances can be destructured similar to records.

```typescript
class Point {
  x: i32;
  y: i32;
}
let p = new Point(10, 20);
let {x, y} = p;
```
