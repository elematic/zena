---
title: 'Classes'
description: 'Classes, constructors, inheritance, interfaces, mixins, case classes, and polymorphism in Zena.'
---

Classes in Zena are nominal, object-oriented types targeting WebAssembly GC.
They provide single inheritance, multiple interface implementation, mixin
composition, Dart-style constructors, accessors, immutability by default, and
pattern matching.

## Declaring a class and fields

Classes are declared using the `class` keyword. By default, fields are
**immutable** and **publicly readable**:

```zena
class User {
  id: i32;                   // Immutable (default)
  let createdAt: i64;        // Immutable (explicit 'let' is accepted)
  var email: String;         // Mutable (public getter and setter)
  var(#phone) phone: String; // Mutable with private setter
}
```

### Field mutability and access modifiers

Zena controls field visibility and mutability through field modifiers:

| Declaration Syntax      | Read Visibility   | Write Visibility  | Mutability          |
| :---------------------- | :---------------- | :---------------- | :------------------ |
| `name: Type`            | Public            | Constructor only  | Immutable (default) |
| `let name: Type`        | Public            | Constructor only  | Immutable           |
| `var name: Type`        | Public            | Public            | Mutable             |
| `var(#name) name: Type` | Public (`name`)   | Private (`#name`) | Mutable             |
| `#name: Type`           | Private (`#name`) | Constructor only  | Immutable           |
| `var #name: Type`       | Private (`#name`) | Private (`#name`) | Mutable             |

### Private setters with `var(#name)`

The `var(#name) name: Type` syntax creates a field that is publicly readable
via `name`, but only writable within the class via the private identifier `#name`:

```zena
class Counter {
  var(#count) count: i32 = 0;

  increment(): void {
    this.#count += 1; // Writable internally via #count
  }
}

let c = new Counter();
let val = c.count; // OK: Public read
// c.count = 5;    // Compile error: No public setter
```

### Nullable fields and defaults

Fields of reference types can be marked nullable with `?`. Nullable reference
fields default to `null` and do not require explicit initialization:

```zena
class TreeNode {
  value: i32;
  var left: TreeNode?;  // Defaults to null
  var right: TreeNode?; // Defaults to null

  new(this.value);
}
```

::: note Primitive Types Cannot Be Null
Primitive types (`i32`, `f64`, `boolean`) cannot be nullable. A field like `var count: i32?;` is rejected by the compiler.
:::

## Constructors and initialization

Constructors are declared using the `new` keyword. Zena uses Dart-style
constructor parameter assignment and initializer lists.

### `this.` parameter shorthand

When constructor parameters directly initialize fields of the same name, use
the `this.fieldName` shorthand. The parameter type is inferred directly from
the field declaration:

```zena
class Point {
  x: f64;
  y: f64;

  // Types of x and y are inferred from field declarations
  new(this.x, this.y);
}
```

Constructors with no body statements can end with a semicolon `;` instead of
empty braces `{}`.

### Initializer lists

For calculated values, field validation, or private field assignments, use an
initializer list separated by commas between `:` and `{}`:

```zena
class Rectangle {
  width: i32;
  height: i32;
  area: i32;
  #debugName: String;

  new(w: i32, h: i32, label: String)
    : width = w,
      height = h,
      area = w * h,
      #debugName = label {
    // Body runs after all fields are initialized
  }
}
```

Expressions in the initializer list can access constructor parameters and
earlier initialized fields by their bare name. They **cannot** access `this`
because the instance is not fully constructed until the initializer list
finishes.

### Mandatory field initialization

Zena requires that all **immutable** fields and all **non-nullable** fields are
definitely initialized before the constructor body begins executing.

A field can be initialized through any of three mechanisms:

1. **Field declaration initializer**: `var count: i32 = 0;`
2. **`this.field` constructor parameter**: `new(this.x, this.y);`
3. **Initializer list entry**: `new(w: i32) : width = w;`

If an immutable or non-nullable field has no default value and is omitted from
both the `this.` parameter list and the initializer list, the compiler rejects
the declaration at compile time.

Nullable reference fields (`var next: Node?`) do not require explicit
initialization and default to `null`.

### Subclass initialization with `super()`

Derived classes call their superclass constructor using `super(...)` inside the
initializer list. `super()` must appear as the **last entry** in the initializer
list:

```zena
class Shape {
  color: String;
  new(this.color);
}

class Circle extends Shape {
  radius: f64;

  new(radius: f64, color: String)
    : radius = radius,
      super(color) {
    // Both Circle and Shape fields are now initialized
  }
}
```

Placing subclass initialization before `super()` guarantees that all subclass
fields are initialized before any superclass code (or virtual method calls) can
execute.

## Methods and accessors

Methods are defined inside the class body. They have implicit access to `this`:

```zena
class Point {
  var x: f64;
  var y: f64;
  new(this.x, this.y);

  translate(dx: f64, dy: f64): void {
    this.x += dx;
    this.y += dy;
  }
}
```

### Getters and setters

Computed properties use `get` and `set` accessors:

```zena
class Circle {
  var radius: f64;
  new(this.radius);

  get diameter(): f64 {
    return this.radius * 2.0;
  }

  set diameter(value: f64) {
    this.radius = value / 2.0;
  }

  get area(): f64 {
    return 3.141592653589793 * this.radius * this.radius;
  }
}

let c = new Circle(5.0);
c.diameter = 20.0;
let a = c.area;
```

### Method overloading

Classes support compile-time method overloading based on parameter count and
types:

```zena
class Logger {
  log(message: String): void {
    this.logLevel('INFO', message);
  }

  log(code: i32, message: String): void {
    this.logLevel('CODE ' + code.toString(), message);
  }

  logLevel(level: String, message: String): void {
    print('[' + level + '] ' + message);
  }
}
```

Overload resolution occurs entirely at compile time without runtime dispatch
overhead.

### Symbol-keyed members

In addition to string-named members, classes can define and implement
**symbol-keyed members** using symbols declared with the `symbol` keyword.
Symbol-keyed members are commonly used for protocol methods (such as
`[Disposable.dispose]` or `[Iterable.iterator]`) and internal APIs that must not
collide with public member names:

```zena
interface Inspectable {
  static symbol inspect;
  [inspect](): String;
}

class User implements Inspectable {
  name: String;
  new(this.name);

  // Implement the symbol-keyed method using [SymbolName]
  [Inspectable.inspect](): String {
    return 'User(' + this.name + ')';
  }
}

let u = new User('Alice');
// Access the symbol-keyed method using .[SymbolName]
let info = u.[Inspectable.inspect]();
```

Symbol-keyed members provide several guarantees:

- **Compile-time resolution**: Symbols in bracket syntax (`[SymbolName]`) are
  resolved statically at compile time with zero runtime symbol table overhead.
- **Collision-free protocols**: Multiple interfaces can declare protocol methods
  without accidental name collisions because each interface binds its own distinct
  static symbol.
- **Visibility control**: Standard `export` rules control symbol access. A
  non-exported symbol creates a module-private protocol that external code cannot
  invoke or accidentally override.

## Case classes and sealed hierarchies

Zena provides concise syntax for data structures, sum types, and pattern
matching.

### Concise case classes

A class declaration with a parameter list immediately after its name is a **case
class**:

```zena
class Point(x: f64, y: f64)
```

This single line generates:

1. Immutable fields for each parameter (`x: f64`, `y: f64`).
2. A constructor `new(this.x, this.y)`.
3. Value-based `operator ==` and `hashCode()` implementations.
4. Record pattern matching support.

Case classes are **implicitly final** (they cannot be extended), which guarantees
sound value equality:

```zena
let p1 = new Point(1.0, 2.0);
let p2 = new Point(1.0, 2.0);
let same = p1 == p2; // true (structural equality)
```

Case class parameters can include `var` for mutable fields or `?` for optional
fields:

```zena
class Task(title: String, var completed: boolean, priority?: i32)
```

### Sealed class hierarchies

A `sealed class` defines a closed set of subclasses declared in the same source
file. Sealed classes are abstract and cannot be instantiated directly:

```zena
sealed class Expr {
  case Lit(value: i32)
  case Add(left: Expr, right: Expr)
  case Neg(expr: Expr)
}
```

Each `case` variant becomes a distinct final subclass. Variants without
parameters are **unit variants** and are allocated as singletons:

```zena
sealed class Option<T> {
  case Some(value: T)
  case None
}

let opt: Option<i32> = new Some(42);
let empty: Option<i32> = new None(); // Returns shared singleton
```

### Exhaustive pattern matching

`match` expressions over sealed classes are exhaustively checked by the compiler
without requiring a default `case _`:

```zena
function evaluate(e: Expr): i32 {
  return match (e) {
    case let Lit { value }: value
    case let Add { left, right }: evaluate(left) + evaluate(right)
    case let Neg { expr }: -evaluate(expr)
  };
}
```

## Interfaces and mixins

Zena separates interface contracts and implementation reuse from single
inheritance.

### Interfaces

An `interface` declares method signatures and field contracts that implementing
classes must satisfy:

```zena
interface Printable {
  toString(): String;
}

interface Serializable {
  serialize(): String;
}

class Document implements Printable, Serializable {
  content: String;
  new(this.content);

  toString(): String {
    return this.content;
  }

  serialize(): String {
    return '{"content":"' + this.content + '"}';
  }
}
```

### Mixins

A `mixin` enables sharing field and method implementations across unrelated
class hierarchies:

```zena
mixin Timestamped {
  var createdAt: i64 = 0;
  var updatedAt: i64 = 0;

  touch(): void {
    this.updatedAt = currentTimeMillis();
  }
}

class Post with Timestamped {
  title: String;
  new(this.title) {
    this.createdAt = currentTimeMillis();
    this.updatedAt = this.createdAt;
  }
}
```

### Constrained mixins with `on`

A mixin can declare an `on` clause to require that any applying class is a
subtype of a specific class or interface. Inside the mixin, `this` has access
to all members of the constrained type:

```zena
interface Entity {
  id: i64;
  save(): void;
}

mixin AutoPersist on Entity {
  persistOnChange(): void {
    print('Saving entity #' + this.id.toString());
    this.save(); // OK: Guaranteed by 'on Entity'
  }
}

class Account(id: i64) with AutoPersist implements Entity {
  save(): void {
    // ...
  }
}
```

## Extension classes

Extension classes add methods, accessors, and operators to existing types
without modifying the target type or allocating wrapper objects:

```zena
extension class StringOps on String {
  get isBlank(): boolean {
    return this.trim().length == 0;
  }

  shout(): String {
    return this.toUpperCase() + '!';
  }
}

let greeting = 'hello';
let loud = greeting.shout(); // 'HELLO!'
```

### Zero-cost erasure on primitives

Extension classes on primitive types or Wasm arrays are erased at compile time:

```zena
final extension class Celsius on f64 {
  toFahrenheit(): f64 {
    return (this as f64) * 1.8 + 32.0;
  }
}

let boiling = 100.0 as Celsius;
let f = boiling.toFahrenheit(); // Compiles to a direct Wasm floating-point call
```

## Inheritance and overriding

Classes support single inheritance with the `extends` clause:

```zena
class Animal {
  name: String;
  new(this.name);

  speak(): String {
    return '...';
  }
}

class Dog extends Animal {
  breed: String;
  new(name: String, this.breed) : super(name);

  speak(): String {
    return 'Woof! I am ' + this.name;
  }
}
```

### Method overriding rules

When overriding a method in a subclass:

- The return type must be **covariant** (equal to or a subtype of the superclass
  return type).
- Parameter types must be **contravariant** (equal to or a supertype of the
  superclass parameter type).
- The override can call the superclass implementation using `super.method(...)`.

```zena
class SpecialDog extends Dog {
  new(name: String, breed: String) : super(name, breed);

  speak(): String {
    return super.speak() + ' (wagging tail)';
  }
}
```

## Operator overloading

Classes can define custom behaviors for arithmetic, comparison, and index
operators using `operator` methods:

```zena
class Vector2D {
  x: f64;
  y: f64;
  new(this.x, this.y);

  operator +(other: Vector2D): Vector2D {
    return new Vector2D(this.x + other.x, this.y + other.y);
  }

  operator ==(other: Vector2D): boolean {
    return this.x == other.x && this.y == other.y;
  }

  operator [](index: i32): f64 {
    if (index == 0) return this.x;
    if (index == 1) return this.y;
    throw new IndexError('Vector2D index out of bounds: ' + index.toString());
  }
}

let v1 = new Vector2D(1.0, 2.0);
let v2 = new Vector2D(3.0, 4.0);
let v3 = v1 + v2;       // Vector2D(4.0, 6.0)
let xCoord = v3[0];     // 4.0
let isEqual = v1 == v2; // false
```

## Performance and dispatch

Zena's object model is designed specifically for WebAssembly GC performance.

### Class hierarchy dispatch vs interfaces

1. **Class single inheritance**:
   - Compiles directly to WebAssembly GC struct hierarchies (`struct.sub`).
   - Virtual method dispatch uses standard virtual method tables (vtables) with
     direct offset indexing.
2. **Interface dispatch and Fat Pointers**:
   - Because a class can implement multiple unrelated interfaces, casting an
     object to an interface type builds an **interface reference (fat pointer)**
     pairing the instance pointer with an adapted interface table (ITable).
   - Calling an interface method accesses the method pointer from the fat
     pointer's ITable.

### Devirtualization with `final`

Marking a class or method as `final` informs the compiler that it cannot be
extended or overridden:

- **`final class`**: Prevents subclassing. The compiler can emit direct Wasm
  `call` instructions for method invocations on exact types, skipping vtable
  lookup entirely.
- **`final` methods**: Prevents method overrides in subclasses, enabling direct
  call emission even when called on a base class reference.
- **Closed-world devirtualization**: Because the Zena compiler operates with
  whole-program awareness, single-implementation interfaces and non-overridden
  virtual methods can be automatically devirtualized to direct calls.

::: note Performance: Direct Calls
When writing performance-sensitive inner loops, prefer concrete class types or
`final` classes over interface types to maximize direct call generation and
inlining opportunities in WebAssembly.
:::

## Next

- [Resources and Ownership](/guide/resources/) — affine types and deterministic cleanup
- [The Type System](/guide/type-system/) — subtyping, variance, and assignability
- [Functions](/guide/functions/) — function declarations, closures, and overloads
