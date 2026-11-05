---
title: 'Methods and Accessors'
description: 'Method declarations, receiver binding, overloading, getters and setters, static members, generic methods, and operator overloads in Zena.'
---

Methods define behavior associated with class instances. Zena supports instance
methods, unified grouped accessors (getters and setters), class-level static
members, generic methods with static monomorphization, and operator overloads.

## Methods

Instance methods are declared directly inside a class body using function signature
syntax without the `function` or `let` keywords:

```zena
class Greeter {
  name: String;

  new(this.name);

  greet(prefix: String): String {
    return prefix + ', ' + this.name + '!';
  }
}
```

### The receiver `this`

Within an instance method, `this` refers to the current instance of the enclosing
class. Accessing instance fields and calling instance methods **always requires**
the explicit `this.` prefix:

```zena
class Counter {
  var count: i32 = 0;

  increment(): void {
    this.count += 1; // Explicit this. required
  }

  isPositive(): boolean {
    return this.count > 0;
  }
}
```

#### Why `this.` is required

Unlike languages where instance members can be referenced as bare identifiers,
Zena requires explicit `this.` to preserve clear lexical scoping:

- **No ambiguity**: A bare identifier always resolves to a local variable,
  parameter, top-level declaration, or imported binding. It can never resolve to an
  instance member.
- **Local inspectability**: Both humans and developer tools can immediately determine
  what an identifier refers to without having to analyze all imported libraries or
  traverse base class hierarchies.
- **Resilience against upstream changes**: Adding an import, a top-level variable,
  or a new class field can never silently change what an existing valid expression in
  a method points to. If an imported module later exports a symbol matching a field
  name, or a superclass adds a field, expressions remain stable and unambiguous.

#### Explicit receiver annotations

In methods that work with affine ownership, the receiver can be explicitly typed
using a leading `this:` parameter before regular arguments:

```zena
class FileHandle {
  #fd: i32;

  new(this.#fd);

  dispose(this: Own<this>): void {
    close(this.#fd);
  }
}
```

The receiver is not a normal parameter; it defines the ownership capability
required of the caller when invoking the method.

### Private and symbol methods

Methods can be encapsulated using private names or unique symbols.

#### Private methods (`#`)

Prefixing a method name with `#` restricts its visibility to the lexical body of
the declaring class:

```zena
class Parser {
  parse(input: String): AST {
    this.#tokenize(input);
    return this.#buildTree();
  }

  #tokenize(input: String): void {
    // Accessible only within Parser
  }

  #buildTree(): AST {
    // Accessible only within Parser
  }
}
```

Zena adopts `#` syntax to be immediately familiar to JavaScript and TypeScript
developers, but it also establishes a separate, non-virtual namespace from public
methods:

- **Separate, non-virtual namespace**: Private names occupy an isolated namespace
  apart from public members. A `#` method never occupies a slot in the class's
  virtual method table (vtable), cannot be overridden by subclasses, and never
  collides with or shadows identically named methods in superclasses or subclasses.
- **Direct dispatch and inlining**: Because private methods cannot be overridden or
  virtually dispatched, calls like `this.#tokenize(...)` always compile directly to
  static WebAssembly function calls (`call $func`) rather than indirect vtable lookups
  (`call_ref`). This eliminates dispatch overhead and enables immediate inlining and
  dead code elimination.
- **Encapsulation and performance**: Developers should prefer private names for
  internal helper logic to enforce true encapsulation while achieving optimal
  runtime performance.

#### Symbol methods

```zena
symbol inspect;

class SecurePayload {
  [inspect](): String {
    return 'payload data';
  }
}
```

Only modules with access to the `inspect` symbol can invoke the method on
instances of `SecurePayload`.

### Method overloading

A class can declare multiple methods with the same name, provided their parameter
signatures are distinct:

```zena
class Printer {
  print(val: i32): void {
    console.log('int: ' + val.toString());
  }

  print(val: f64): void {
    console.log('float: ' + val.toString());
  }

  print(val: String): void {
    console.log('string: ' + val);
  }
}
```

#### Most-specific selection

Overload resolution is entirely **static**. For every call site, the compiler
evaluates applicable candidate signatures using static types and selects the
unique **most specific** candidate:

1. **Applicability**: A candidate is applicable if the caller provides the
   expected number of arguments and every argument type is assignable to the
   corresponding parameter type.
2. **Specificity**: Signature `A` is at least as specific as signature `B` if
   every parameter of `A` is assignable to the corresponding parameter of `B`.
3. **Selection**: The call dispatches to the candidate that is at least as
   specific as every other applicable candidate. If multiple candidates apply
   without a unique most-specific match, the compiler reports an ambiguous
   overload error.

```zena
class Base {}
class Derived extends Base {}

class Handler {
  handle(b: Base): i32 { return 1; }
  handle(d: Derived): i32 { return 2; }
}

let h = new Handler();
let d = new Derived();
let result = h.handle(d); // Picks handle(Derived) -> 2
```

#### Two-tier literal adaptation

Bare numeric literals initially assume their natural default types: `i32` for
integers without decimal points, and `f64` for decimals. Overload resolution first
evaluates candidates using these default types.

Only when no candidates apply does a second evaluation tier run, judging bare
literals by whether they can safely widen or adapt to acceptable parameter types
(such as `u32` or `f32`). This prevents literals from creating false ambiguities
when exact matches exist.

#### Subclass overlap restriction

Subclasses inherit overload sets from their parent classes and can override
specific signatures in the set. However, a subclass cannot add a _new_ overload
signature that overlaps with an inherited signature. Overlapping overload sets
must be declared in the base class to maintain consistent dispatch semantics.

## Getters and setters

Getters and setters (accessors) intercept property reads and writes with custom
logic. In Zena, accessors for a property are **grouped** together under a single
name and type declaration:

```zena
class Circle {
  radius: f64;

  new(this.radius);

  area: f64 {
    get {
      return 3.141592653589793 * this.radius * this.radius;
    }
    set(value) {
      this.radius = sqrt(value / 3.141592653589793);
    }
  }
}
```

### Grouped syntax advantages

Unlike languages that require separate `get foo()` and `set foo(v)` declarations,
Zena declares the property name and its type annotation once:

- **Single type definition**: The type annotation `area: f64` defines both the
  return type of `get` and the parameter type of `set`, keeping the property's
  type contract synchronized.
- **Consistent scoping**: The getter body receives no parameters and returns a value
  of the declared type. The setter specifies a parameter name (`value`) enclosed in
  parentheses after `set`, which receives an argument of the declared type and
  returns `void` implicitly.
- **Single site for decorators**: Grouping provides a single syntactic declaration
  for attaching decorators to the property as a cohesive unit (for metadata,
  observability, or serialization), once Zena introduces user-defined decorators.

### Read-only and write-only accessors

An accessor block must contain at least a `get` or a `set`, but is not required to
contain both:

```zena
class Temperature {
  kelvin: f64;

  new(this.kelvin);

  // Read-only accessor: omitting 'set'
  celsius: f64 {
    get {
      return this.kelvin - 273.15;
    }
  }

  // Write-only accessor: omitting 'get'
  resetDelta: f64 {
    set(adjustment) {
      this.kelvin += adjustment;
    }
  }
}
```

Attempting to assign to a read-only accessor (`temp.celsius = 25.0`) or read from a
write-only accessor (`let d = temp.resetDelta`) produces a compile-time error.

### Private and symbol accessors

Accessors support private identifiers and symbols:

```zena
class MetricStore {
  var #raw: i32 = 0;

  #scaled: i32 {
    get {
      return this.#raw * 100;
    }
    set(v) {
      this.#raw = v / 100;
    }
  }

  update(factor: i32): void {
    this.#scaled = factor; // Internal access to private accessor
  }
}
```

### Virtual dispatch

Accessors participate in virtual dispatch like methods. A subclass can override an
inherited accessor, and can invoke superclass accessor logic using `super`:

```zena
class BaseGauge {
  reading: i32 {
    get { return 10; }
  }
}

class CalibratedGauge extends BaseGauge {
  reading: i32 {
    get {
      return super.reading + 2;
    }
  }
}
```

## Static members

Static members belong to the class itself rather than to specific instances. They
are declared with the `static` keyword:

```zena
class MathConstants {
  static pi: f64 = 3.141592653589793;
  static var calculationCount: i32 = 0;

  static tau: f64 {
    get {
      return MathConstants.pi * 2.0;
    }
  }

  static square(x: f64): f64 {
    MathConstants.calculationCount += 1;
    return x * x;
  }
}
```

### Access and scoping

Static members exist in a separate static namespace and are accessed using the
class name:

```zena
let tau = MathConstants.tau;
let result = MathConstants.square(5.0);
```

- **No `this`**: Inside static methods and accessors, `this` is not in scope
  because no instance exists.
- **Encapsulation**: Static members can be private (`static #counter: i32 = 0;`),
  restricting their use to code within that class.

### Static inheritance

Subclasses inherit static members from their base classes. You can access an
inherited static member through the subclass identifier:

```zena
class Base {
  static var count: i32 = 10;
  static greet(): String { return 'hello'; }
}

class Derived extends Base {}

let msg = Derived.greet(); // 'hello'
Derived.count += 5;
let current = Base.count;  // 15: both names refer to the same cell
```

Modifying an inherited mutable static variable through a subclass modifies the
underlying storage in the superclass; static fields are not duplicated per subclass.

### Static members on generic classes

Static members on generic classes live outside the scope of the class's type
parameters. Because the static member belongs to the class definition as a whole:

1. **No access to class type parameters**: A static member cannot reference the
   class's generic parameters (`T`).
2. **Single storage cell**: A static field on a generic class `Holder<T>` has
   exactly one shared storage cell across all type parameter instantiations
   (`Holder<i32>` and `Holder<String>` share the same `Holder.count`).
3. **Independent type parameters**: If a static method requires generics, it
   declares its own type parameters:

```zena
class Box<T> {
  item: T;
  new(this.item);

  static var instancesCreated: i32 = 0;

  static of<A>(value: A): Box<A> {
    Box.instancesCreated += 1;
    return new Box<A>(value);
  }
}

let b1 = Box.of(42);       // Box<i32>
let b2 = Box.of('hello');  // Box<String>
let total = Box.instancesCreated; // 2
```

## Generic methods

Instance methods can declare their own type parameters, enabling polymorphic
behavior independent of or in combination with class-level type parameters:

```zena
class List<T> {
  // ...

  map<U>(transform: (item: T) => U): List<U> {
    let result = new List<U>();
    // ...
    return result;
  }
}
```

### Calling generic methods and type inference

Callers can invoke generic methods with explicit type arguments or rely on type
inference:

```zena
let numbers = new List<i32>();

// Type arguments inferred from the callback return type
let strings = numbers.map((n) => n.toString()); // List<String>

// Explicit type arguments
let explicitStrings = numbers.map<String>((n) => n.toString());
```

When type arguments are omitted, the compiler infers them by unifying argument
types against parameter signatures.

### Type parameter constraints

Method type parameters can specify upper bounds using `extends`:

```zena
class Searcher {
  findMax<T extends Comparable<T>>(a: T, b: T): T {
    if (a.compareTo(b) >= 0) {
      return a;
    }
    return b;
  }
}
```

Inside `findMax`, callers may only supply types that implement `Comparable<T>`,
and the method body can safely invoke `a.compareTo(b)`.

### Dispatch and monomorphization

Generic methods can be declared on interfaces as well as classes:

```zena
interface Transformer {
  transform<T>(value: T): T;
}
```

Because Zena targets WebAssembly GC, calls to generic methods are specialized
through whole-program monomorphization. Each distinct type argument combination
receives a specialized function body, allowing unboxed scalar parameters and direct
optimizations without boxing overhead.

## Operator overloads

In Zena, operators are methods declared on classes using the `operator` keyword
followed by the operator symbol:

```zena
class Vector2D {
  x: f64;
  y: f64;

  new(this.x, this.y);

  operator +(other: Vector2D): Vector2D {
    return new Vector2D(this.x + other.x, this.y + other.y);
  }

  operator -(other: Vector2D): Vector2D {
    return new Vector2D(this.x - other.x, this.y - other.y);
  }

  operator *(scalar: f64): Vector2D {
    return new Vector2D(this.x * scalar, this.y * scalar);
  }
}

let v1 = new Vector2D(1.0, 2.0);
let v2 = new Vector2D(3.0, 4.0);
let v3 = v1 + v2; // Calls v1.operator +(v2)
```

### Supported operators

Zena allows overloading the following binary and subscript operators:

- **Arithmetic operators**: `+`, `-`, `*`, `/`, `%`, `**`
- **Bitwise and shift operators**: `&`, `|`, `^`, `<<`, `>>`, `>>>`
- **Equality operator**: `==`
- **Subscript index operators**: `[]` (read) and `[]=` (write)

#### No unary operator overloading

Zena does not support overloading unary operators such as unary negation (`-x`).
Classes that provide negation or absolute value operations implement them as
standard named methods (such as `v.neg()` or `v.abs()`), consistent with SIMD and
mathematical types in the standard library.

### Value equality and hashing

Defining `operator ==` customizes value equality comparison for a class:

```zena
class Point {
  x: i32;
  y: i32;

  new(this.x, this.y);

  operator ==(other: Point): boolean {
    return this.x == other.x && this.y == other.y;
  }

  hashCode(): i32 {
    return this.x * 31 + this.y;
  }
}
```

- **Synthesized inequality (`!=`)**: The `!=` operator is automatically synthesized
  by the compiler as the logical negation of `==` (`!(a == b)`). It cannot be
  declared or overridden independently.
- **Reference equality (`===` and `!==`)**: Strict reference equality operators
  `===` and `!==` always test object reference identity (or primitive bit equivalence).
  They cannot be overloaded.
- **Contract with `hashCode()`**: Classes that implement custom value equality and
  are stored in hash-based collections (`HashMap`, `HashSet`) should implement the
  `Hashable` interface by providing a `hashCode(): i32` method. Equal objects
  (`a == b`) must produce identical hash codes. (Note that [case classes](/reference/classes/sealed/)
  generate conforming `operator ==` and `hashCode()` implementations automatically.)

### Index operators

Subscript indexing can be defined by implementing `operator []` for reading and
`operator []=` for writing:

```zena
class Grid<T> {
  var #cells: Array<T>;
  width: i32;

  new(this.width, this.#cells);

  operator [](index: i32): T {
    return this.#cells[index];
  }

  operator []=(index: i32, value: T): void {
    this.#cells[index] = value;
  }
}

let grid = new Grid<String>(10, ['empty']);
let cell = grid[0];   // Calls grid.operator [](0)
grid[0] = 'occupied'; // Calls grid.operator []=(0, 'occupied')
```

- **Multiple overloads**: A class can overload `operator []` and `operator []=`
  with distinct parameter types (for example, indexing by integer position or by
  string key).
- **Compound assignments**: Compound assignments on indexed expressions (such as
  `counts[key] += 1`) resolve both the read `operator []` and the write
  `operator []=` overloads at compile time.

### Virtual dispatch of operators

Because operator members are methods, they participate in virtual dispatch:

- Subclasses can override inherited operator methods.
- Invoking an operator on a base class reference (`baseA + baseB`) dispatches
  dynamically through the receiver's virtual table (vtable) to the runtime
  subclass's implementation.
- Calls to operators on `final` classes or references of known concrete types are
  statically devirtualized by the compiler.
