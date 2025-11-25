# Rhea Language Reference

This document describes the syntax and semantics of the Rhea programming language.

## 1. Introduction

Rhea is a statically typed language targeting WebAssembly (WASM-GC). It features a TypeScript-like syntax with strict static typing and no implicit coercion.

## 2. Types

Rhea is strongly typed. All expressions have a type determined at compile time.

### Primitive Types

- **`i32`**: 32-bit signed integer. This is the default type for integer literals.
- **`f32`**: 32-bit floating-point number.
- **`boolean`**: Boolean value (`true` or `false`).
- **`string`**: UTF-8 string.

### Type Inference

Local variable types are inferred from their initializer expression.

```typescript
let x = 10; // Inferred as i32
let s = 'hello'; // Inferred as string
```

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

Rhea currently supports functions using arrow syntax.

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

## 5. Expressions & Operators

### Literals

- **Numbers**: `123`, `0`, `-5` (Parsed as `i32` by default).
- **Strings**: `"text"`.

### Binary Operators

Supported arithmetic operators for numeric types (`i32`, `f32`):

- `+` (Addition)
- `-` (Subtraction)
- `*` (Multiplication)
- `/` (Division)

Operands must be of the same type. Implicit coercion is not supported.

```typescript
let a = 10;
let b = 20;
let c = a + b; // Valid
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

- `==` (Equal)
- `!=` (Not Equal)
- `<` (Less Than)
- `<=` (Less Than or Equal)
- `>` (Greater Than)
- `>=` (Greater Than or Equal)

These operators return a boolean value.

## 6. Control Flow

### If Statement

Rhea supports `if` and `else` for conditional execution.

```typescript
if (condition) {
  // consequent
} else {
  // alternate
}
```

### While Statement

Rhea supports `while` loops.

```typescript
while (condition) {
  // body
}
```

## 7. Modules & Exports

### Exports

Top-level variable declarations can be exported using the `export` keyword. This exposes the variable (or function) to the host environment or other modules.

```typescript
export const add = (a: i32, b: i32) => a + b;
```

## 8. Classes

Rhea supports classes with fields, methods, and constructors.

### Class Declaration

Classes are declared using the `class` keyword.

```typescript
class Point {
  x: i32;
  y: i32;

  #new(x: i32, y: i32) {
    this.x = x;
    this.y = y;
  }

  distance(): i32 {
    // ...
    return 0;
  }
}
```

### Fields

Fields are declared with a name and a type annotation. They define the layout of the underlying WASM struct.

```typescript
class User {
  id: i32;
  name: string;
}
```

### Constructor

The constructor is a special method named `#new`. It is called when a new instance of the class is created.

```typescript
class Box {
  value: i32;
  #new(v: i32) {
    this.value = v;
  }
}
```

### Methods

Methods are functions defined within the class body.

```typescript
class Counter {
  count: i32;
  increment() {
    this.count = this.count + 1;
  }
}
```

### Instantiation

Classes are instantiated using the `new` keyword.

```typescript
let p = new Point(10, 20);
```

### Member Access

Fields and methods are accessed using the dot `.` operator.

```typescript
let x = p.x;
p.distance();
```

### `this` Keyword

Inside methods and the constructor, `this` refers to the current instance of the class.

```typescript
class A {
  x: i32;
  setX(v: i32) {
    this.x = v;
  }
}
```

## 7. Grammar (Simplified)

```ebnf
Program ::= Statement*

Statement ::= ExportStatement | VariableDeclaration | ExpressionStatement | BlockStatement | ReturnStatement | IfStatement | WhileStatement

ExportStatement ::= "export" VariableDeclaration

VariableDeclaration ::= ("let" | "var") Identifier "=" Expression ";"

ExpressionStatement ::= Expression ";"

BlockStatement ::= "{" Statement* "}"

ReturnStatement ::= "return" Expression? ";"

IfStatement ::= "if" "(" Expression ")" Statement ("else" Statement)?

WhileStatement ::= "while" "(" Expression ")" Statement

Expression ::= ArrowFunction | AssignmentExpression | BinaryExpression | CallExpression | NewExpression | MemberExpression

AssignmentExpression ::= (Identifier | MemberExpression) "=" Expression

CallExpression ::= Expression "(" (Expression ("," Expression)*)? ")"

NewExpression ::= "new" Identifier "(" (Expression ("," Expression)*)? ")"

MemberExpression ::= Expression "." Identifier

ArrowFunction ::= "(" ParameterList? ")" (":" TypeAnnotation)? "=>" Expression

ParameterList ::= Parameter ("," Parameter)*

Parameter ::= Identifier ":" TypeAnnotation

BinaryExpression ::= PrimaryExpression (Operator PrimaryExpression)*

PrimaryExpression ::= NumberLiteral | StringLiteral | Identifier | "(" Expression ")"

Operator ::= "+" | "-" | "*" | "/"
```
