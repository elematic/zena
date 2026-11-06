---
title: 'Fields and Constructors'
description: 'Declaring fields, mutability modifiers, private fields, asymmetric visibility, constructors, and initializer lists in Zena.'
---

Fields store per-instance state, and constructors initialize new instances when
invoked with `new`. Zena provides immutable fields by default, asymmetric
visibility for encapsulation, and Dart-style constructors with `this.` parameters
and initializer lists.

## Instance creation

In Zena, creating an instance follows a strict three-phase lifecycle:
**initialization**, **allocation**, and **construction**. Understanding this sequence
is key to how fields and constructors operate:

1. **Initialization**: Field default expressions and constructor initializer lists
   (including `this.` parameter assignments) are evaluated. All initial field values
   are computed before the object exists in memory.
2. **Allocation**: The WebAssembly GC struct is allocated with `struct.new`, passing
   all computed field values at once.
3. **Construction**: The constructor body runs with a fully formed, valid `this`
   reference.

### Why initialization precedes allocation

In WebAssembly GC, struct fields declared as immutable (`(field T)`) or non-nullable
(`(field (ref T))`) must be supplied at allocation time; they cannot be allocated
uninitialized and populated later.

By completing initialization before allocation, Zena achieves two critical design
goals:

- **Optimal WebAssembly GC structs**: Fields can be emitted as truly immutable and
  non-nullable in WebAssembly, enabling engines to eliminate null checks and cache
  field values in registers across calls.
- **No partially initialized instances**: A constructor body can never observe `this`
  in an incomplete or partially initialized state. All immutable and non-nullable
  fields are guaranteed to hold valid values before any constructor code or virtual
  methods can execute.

## Field declarations

Fields are declared directly within the class body by providing a name and a
type annotation, with an optional default initializer:

```zena
class User {
  id: i32;
  name: String;
  active: boolean = true;
}
```

If a field has a default initializer expression, that expression is evaluated
each time an instance is constructed. Fields without default initializers must be
assigned during construction.

## var and let fields

In Zena, class fields are **immutable by default**:

```zena
class Account {
  id: i32;            // Immutable (default)
  let createdAt: i64; // Immutable (explicit 'let', same as bare)
  var balance: f64;   // Mutable
}
```

### Mutability modifiers

- **Bare `name: Type` or `let name: Type`**: Declares an immutable field. The
  field must be initialized at declaration or in the constructor. Once
  constructed, its value cannot be changed.
- **`var name: Type`**: Declares a mutable field. The field generates both a
  public getter and a public setter, allowing reassignment on any instance:

```zena
let account = new Account(1, 1000, 100.0);
account.balance = 150.0; // OK: balance is mutable
// account.id = 2;       // Compile error: id is immutable
```

## Private fields

Fields can be kept private to a class by prefixing their identifier with `#`:

```zena
class BankVault {
  #passcode: String;
  var #failedAttempts: i32 = 0;

  new(this.#passcode);

  unlock(code: String): boolean {
    if (code == this.#passcode) {
      this.#failedAttempts = 0;
      return true;
    }
    this.#failedAttempts += 1;
    return false;
  }
}
```

Private fields are accessible only within methods, accessors, and constructors
of the class that declares them:

- `#name: Type`: An immutable private field.
- `var #name: Type`: A mutable private field.

Attempting to access a private field from outside the enclosing class (such as
`vault.#passcode`) produces a compile-time error.

Zena adopts `#` syntax to be familiar to JavaScript and TypeScript developers.
Private fields occupy an isolated, non-virtual namespace: they are never routed
through virtual getter/setter lookups, and their storage is resolved directly at
fixed struct offsets without risk of collision or shadowing across inheritance
hierarchies. Developers should prefer private names for internal state to ensure
strong encapsulation and optimal performance.

## Asymmetric visibility

A common object-oriented pattern requires exposing a field for public reading
while restricting modification to internal class methods. Zena supports this
natively through asymmetric field declarations:

```zena
class Counter {
  var(#count) count: i32 = 0;

  increment(): void {
    this.#count += 1; // Writable internally via #count
  }
}
```

The syntax `var(#setterName) getterName: Type` creates:

1. A **public getter** accessible via `getterName`.
2. A **private setter** accessible only within the class via `this.#setterName`.

```zena
let counter = new Counter();
let current = counter.count; // OK: public getter
// counter.count = 10;       // Compile error: no public setter for 'count'
// counter.#count = 10;      // Compile error: #count is private to Counter
```

### Symbol-based setters

The setter name can also be a declared `symbol`, enabling capability-based
write permissions across module boundaries:

```zena
symbol updateState;

class Component {
  var([updateState]) state: State;

  new(this.state);
}

// In the framework module that imports 'updateState':
component.[updateState] = newState;
```

Code that imports the `Component` class can read `component.state`, but only code
with access to the `updateState` symbol can write to it.

## Constructors

Constructors initialize class instances and are declared using the `new` keyword.

### Default constructors

A class has at most one default (unnamed) constructor:

```zena
class Point {
  x: f64;
  y: f64;

  new(x: f64, y: f64) {
    this.x = x;
    this.y = y;
  }
}
```

### Semicolon bodies

When a constructor contains no logic other than initializing fields through its
parameter list or initializer list, its body can be written as a single semicolon
rather than empty braces `{}`:

```zena
class Point {
  x: f64;
  y: f64;
  new(this.x, this.y);
}
```

### Named constructors

A class can define multiple constructors by providing an identifier after `new`:

```zena
class Point {
  x: f64;
  y: f64;

  new(this.x, this.y);

  new origin()
    : x = 0.0, y = 0.0;

  new fromX(x: f64)
    : x = x, y = 0.0;
}
```

Named constructors are invoked by qualifying the class name:

```zena
let p1 = new Point(3.0, 4.0);
let p2 = new Point.origin();
let p3 = new Point.fromX(5.0);
```

Named constructors can also use private names (`new #internal(...)`) or symbols
(`new [symbolName](...)`) to restrict who can instantiate the class through that
specific path.

## this. parameters

To eliminate repetitive parameter-to-field assignments, Zena supports
Dart-style `this.` parameters:

```zena
class Point {
  x: f64;
  y: f64;

  new(this.x, this.y);
}
```

When a constructor parameter is prefixed with `this.`:

1. **Automatic type inference**: The parameter's type is inferred directly from
   the field declaration (`f64` for `this.x`). Explicit type annotations may be
   omitted.
2. **Automatic assignment**: The parameter value is assigned to the corresponding
   field before the constructor body or initializer list executes.

`this.` parameters can be combined with regular parameters and default values:

```zena
class Color {
  r: i32;
  g: i32;
  b: i32;
  a: f64;

  new(this.r, this.g, this.b, this.a = 1.0);
}
```

## Initializer lists

Initializer lists allow fields to be assigned calculated values before the
constructor body executes. An initializer list begins with a colon `:` between the
parameter list and the constructor body:

```zena
class Rectangle {
  width: f64;
  height: f64;
  area: f64;

  new(w: f64, h: f64)
    : width = w,
      height = h,
      area = this.width * this.height;
}
```

### Rules for initializer lists

1. **Access to earlier fields (`this.field`)**: Initializer expressions can reference
   constructor parameters and previously initialized fields using explicit `this.fieldName`
   syntax (including fields set by `this.` parameters or field default expressions).
   The compiler resolves `this.fieldName` directly to the field's already-computed value.
   Bare field names (like `width`) are not in scope.
2. **No instance references or method calls**: Because expressions evaluate during the
   initialization phase before the WebAssembly struct is allocated with `struct.new`,
   `this` cannot be used as an allocated object reference. You cannot call methods
   (`this.method()`), invoke accessors or getters, or pass `this` as an argument.
3. **Immutable field assignment**: Initializer lists can initialize immutable
   (`let`) fields with computed values that cannot be computed at declaration
   time.
4. **Combined with `this.` parameters**: When a constructor combines `this.`
   parameters and an initializer list, the `this.` parameter assignments apply
   first, making their values immediately accessible to subsequent initializer list
   entries via `this.fieldName`:

   ```zena
   class Square {
     side: f64;
     area: f64;

     new(this.side)
       : area = this.side * this.side;
   }
   ```

### Calling superclass constructors

In derived classes, the superclass constructor must be invoked using `super(...)`
or `super.named(...)` in the initializer list:

```zena
class Point3D extends Point {
  z: f64;

  new(x: f64, y: f64, this.z)
    : super(x, y);
}
```

`super()` must be the **last entry** in the initializer list. This ensures that
all subclass fields are initialized before the superclass constructor executes,
preventing subclasses from being observed in an uninitialized state if the
superclass constructor invokes virtual methods.

### Constructor contracts

Constructors accept `requires` and `ensures` clauses after the parameter list and
before `: initializerList` or the body:

```zena
class BoundedRange {
  low: i32;
  high: i32;

  new(low: i32, high: i32)
    requires (low <= high)
    ensures (this.low <= this.high)
    : low = low, high = high {}
}
```

- `requires` clauses run before `this.` assignments, initializer list entries,
  and `super(...)` calls, and cannot reference `this`.
- `ensures` clauses run after the constructor body with `this` bound to the
  constructed instance (constructors have no `result`, and `old()` in constructor
  `ensures` is not yet supported).

See [Contracts](/reference/contracts/).
