# Zena Language Reference

This document describes the syntax and semantics of the Zena programming language.

## 1. Introduction

Zena is a statically typed language targeting WebAssembly (WASM-GC). It features a TypeScript-like syntax with strict static typing and no implicit coercion.

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

## 5. Expressions & Operators

### Literals

- **Numbers**: `123`, `0`, `-5` (Parsed as `i32` by default).
- **Strings**: `"text"`.

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

## 7. Modules & Exports

### Exports

Top-level variable declarations can be exported using the `export` keyword. This exposes the variable (or function) to the host environment or other modules.

```typescript
export const add = (a: i32, b: i32) => a + b;
```

## 8. Classes

Zena supports classes with fields, methods, and constructors.

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

### Operator Overloading

Classes can define custom behavior for the index operator `[]` by implementing `operator []` and `operator []=`.

- `operator [](index: Type): ReturnType`: Defines the behavior for reading an element (e.g., `obj[i]`).
- `operator []=(index: Type, value: ValueType): void`: Defines the behavior for writing an element (e.g., `obj[i] = v`).

```typescript
class List {
  operator [](index: i32): i32 {
    // ... return element at index
    return 0;
  }

  operator []=(index: i32, value: i32): void {
    // ... set element at index
  }
}

let list = new List();
let x = list[0]; // Calls operator []
list[1] = 10;    // Calls operator []=
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

### Inheritance

Classes can inherit from other classes using the `extends` keyword. Subclasses inherit all fields and methods from the superclass.

```typescript
class Animal {
  speak(): i32 {
    return 0;
  }
}

class Dog extends Animal {
  speak(): i32 {
    return 1;
  }
}
```

#### Method Overriding

Subclasses can override methods defined in the superclass. Zena supports dynamic dispatch, meaning the method implementation corresponding to the runtime type of the object will be called.

```typescript
let a: Animal = new Dog();
a.speak(); // Returns 1 (Dog's implementation)
```

### Abstract Classes

Abstract classes are classes that cannot be instantiated directly. They are used as base classes for other classes.

- Defined using the `abstract` keyword.
- Can contain abstract methods (methods without a body).
- Concrete subclasses MUST implement all abstract methods.

```typescript
abstract class Shape {
  abstract area(): i32;

  getType(): i32 {
    return 1;
  }
}

class Square extends Shape {
  side: i32;
  #new(side: i32) {
    this.side = side;
  }

  area(): i32 {
    return this.side * this.side;
  }
}
```

### Abstract Classes

Classes can be declared as `abstract`. Abstract classes cannot be instantiated directly. They can contain abstract methods, which are methods without a body that must be implemented by concrete subclasses.

```typescript
abstract class Shape {
  abstract area(): i32;
}

class Square extends Shape {
  side: i32;
  #new(side: i32) {
    this.side = side;
  }
  area(): i32 {
    return this.side * this.side;
  }
}
```

## 9. Mixins

Mixins provide a way to reuse code across multiple class hierarchies. They act as "subclass factories" that can be applied to various base classes.

### Defining a Mixin

Mixins are defined using the `mixin` keyword. They look similar to classes but cannot be instantiated directly.

```typescript
mixin Timestamped {
  timestamp: i32 = 0;

  getAge(): i32 {
    return 100; // Placeholder
  }
}
```

### Applying Mixins

Mixins are applied to a class using the `with` keyword in the `class` declaration.

```typescript
class User {
  name: string;
}

class RegisteredUser extends User with Timestamped {
  // ...
}
```

This creates a new class `RegisteredUser` that extends `User` and includes the members of `Timestamped`.

### Constraining Mixins (`on` clause)

A mixin can restrict which classes it can be applied to using the `on` keyword. This allows the mixin to call methods on `super` or access properties that are guaranteed to exist on the base class.

```typescript
class Entity {
  id: i32;
  save(): void { /* ... */ }
}

mixin Syncable on Entity {
  sync(): void {
    this.save(); // OK because of 'on Entity'
  }
}
```

### Composition

Multiple mixins can be applied in a single declaration.

```typescript
class MyClass extends Base with MixinA, MixinB {
  // ...
}
```

The application order is linear: `Base` -> `Base+MixinA` -> `Base+MixinA+MixinB` -> `MyClass`.

## 10. Generics

Zena supports generic classes and functions, allowing code reuse across different types.

### Generic Classes

Classes can be parameterized with one or more type variables.

```typescript
class Box<T> {
  value: T;
  #new(v: T) {
    this.value = v;
  }
}

let b1 = new Box<i32>(10);
let b2 = new Box<f32>(3.14);
```

### Multiple Type Parameters

Classes can have multiple type parameters.

```typescript
class Pair<K, V> {
  key: K;
  value: V;
  #new(k: K, v: V) {
    this.key = k;
    this.value = v;
  }
}

let p = new Pair<i32, string>(1, 'one');
```

### Generic Functions

Functions can also be generic.

```typescript
const identity = <T>(x: T): T => x;
```

### Type Inference

Type arguments for generic classes and functions can often be inferred from the arguments passed to the constructor or function.

```typescript
let b = new Box(10); // Infers Box<i32>
let i = identity(42); // Infers T = i32
```

### Default Type Parameters

Generic type parameters can specify a default type, which is used if no type argument is provided and inference is not possible.

```typescript
class Container<T = i32> {
  value: T;
  // ...
}

let c = new Container(); // T is i32
```

### Monomorphization

Zena implements generics via monomorphization. This means a separate version of the class or function is generated for each unique combination of type arguments. This ensures high performance (no boxing) but may increase binary size.

## 11. Arrays

Zena supports mutable arrays backed by WASM GC arrays.

### Array Literal

Arrays are created using the `#[ ... ]` syntax.

```typescript
let arr = #[1, 2, 3];
```

### Index Access

Array elements are accessed using square brackets `[]`.

```typescript
let x = arr[0];
```

### Assignment

Array elements can be modified using assignment.

```typescript
arr[0] = 10;
```

## 12. Strings

Zena supports UTF-8 encoded strings.

### Type

The type of a string is `string`. Strings are immutable.

### Literals

String literals can be enclosed in double quotes `"` or single quotes `'`.

```typescript
let s1 = 'Hello';
let s2 = 'World';
```

### Concatenation

Strings can be concatenated using the `+` operator.

```typescript
let s3 = s1 + ' ' + s2;
```

### Equality

The `==` and `!=` operators perform value equality checks. Two strings are considered equal if they have the same length and identical byte content.

```typescript
let a = 'foo';
let b = 'f' + 'oo';
if (a == b) {
  // This block executes
}
```

### Length

The length of a string (in bytes) can be accessed using the `.length` property.

```typescript
let len = 'hello'.length; // 5
```

### Indexing

Individual bytes (characters) of a string can be accessed using the index operator `[]`. This returns the byte value as an `i32`.

```typescript
let charCode = 'ABC'[0]; // 65
```

## 13. Grammar (Simplified)

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

Expression ::= ArrowFunction | AssignmentExpression | BinaryExpression | CallExpression | NewExpression | MemberExpression | ArrayLiteral | IndexExpression

AssignmentExpression ::= (Identifier | MemberExpression | IndexExpression) "=" Expression

CallExpression ::= Expression "(" (Expression ("," Expression)*)? ")"

NewExpression ::= "new" Identifier "(" (Expression ("," Expression)*)? ")"

MemberExpression ::= Expression "." Identifier

ArrayLiteral ::= "#[" (Expression ("," Expression)*)? "]"

IndexExpression ::= Expression "[" Expression "]"

ArrowFunction ::= "(" ParameterList? ")" (":" TypeAnnotation)? "=>" Expression

ParameterList ::= Parameter ("," Parameter)*

Parameter ::= Identifier ":" TypeAnnotation

BinaryExpression ::= PrimaryExpression (Operator PrimaryExpression)*

PrimaryExpression ::= NumberLiteral | StringLiteral | Identifier | "(" Expression ")"

Operator ::= "+" | "-" | "*" | "/"
```
