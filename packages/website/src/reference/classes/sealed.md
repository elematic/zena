---
title: 'Sealed and Case Classes'
description: 'Algebraic data types, closed class hierarchies, case class shorthand, value equality, and exhaustive pattern matching in Zena.'
---

Zena supports algebraic data types (sum types and product types) through **sealed classes**
and **case classes**. Together, they allow modeling domain data as closed type hierarchies
with structural equality, automatic hash code generation, and compile-time exhaustive
pattern matching.

## sealed class

A `sealed class` defines a closed class hierarchy. All subclasses and variants of a sealed
class must be declared in the same source file. This allows the compiler to know every
possible subtype at compile time, guaranteeing that pattern matching over the hierarchy
can be checked for completeness.

```zena
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}
```

### Implicitly abstract

Sealed classes are implicitly `abstract`. You cannot instantiate a sealed base class
directly:

```zena
let c: Shape = new Circle(5.0); // OK: variant instantiation
let s = new Shape();            // Compile error: Cannot instantiate abstract class
```

### Nested sealed hierarchies (sum of sums)

A variant of a sealed class can itself be a sealed class, enabling hierarchical sum
types:

```zena
sealed class Node {
  case Expr, Stmt
}

sealed class Expr extends Node {
  case Lit, Add
}

final class Lit(value: i32) extends Expr
final class Add(left: Expr, right: Expr) extends Expr

sealed class Stmt extends Node {
  case ReturnStmt, ExprStmt
}

final class ReturnStmt(value: Expr) extends Stmt
final class ExprStmt(expr: Expr) extends Stmt
```

When pattern matching on a root reference of type `Node`, the compiler requires covering
all concrete leaf variants transitively (`Lit`, `Add`, `ReturnStmt`, `ExprStmt`).

### Abstract fields in sealed classes

A sealed class can declare `abstract` fields. An abstract field allocates no storage in
the base class struct. Instead, it creates a virtual getter (and setter if declared with
`var`) in the base class vtable:

```zena
sealed class ASTNode {
  case Identifier, Literal
  abstract loc: i32;
}

final class Identifier(name: String, loc: i32) extends ASTNode
final class Literal(value: i32, loc: i32) extends ASTNode
```

Subclasses satisfy the abstract field contract through their case parameters or explicit
field declarations. Because the getter exists in the base class vtable, you can read the
field polymorphically through a base-typed reference without downcasting:

```zena
let printLocation = (node: ASTNode): i32 => {
  return node.loc; // Virtual dispatch through ASTNode vtable
};
```

## case declarations

Variants of a sealed class are declared inside the class body using `case` declarations.
Zena supports three styles of case declarations: **inline case variants**, **unit variants**,
and **distributed variants**.

### Inline case variants

An inline `case` declaration defines a variant subclass directly inside the sealed class
body with a parameter list:

```zena
sealed class Command {
  case Move(x: i32, y: i32)
  case Draw(color: String, size: i32)
}
```

The compiler synthesizes a concrete subclass for each variant that:

- Extends the enclosing sealed class.
- Declares immutable fields corresponding to the parameter list.
- Generates a constructor assigning each argument to its field.
- Implements value-based equality (`operator ==`) and hashing (`hashCode()`).

Variant instances are constructed with `new`:

```zena
let cmd: Command = new Move(10, 20);
```

### Unit variants

Variants that carry no data can be declared as a comma-separated list of names without
parameter parentheses. These are called **unit variants**:

```zena
sealed class Color {
  case Red, Green, Blue
}
```

Unit variants are compiled as singletons. Multiple constructor calls return the exact
same canonical instance:

```zena
let c1 = new Red();
let c2 = new Red();

let same = c1 === c2; // true: unit variants are singletons
```

### Distributed variants

When a variant needs custom methods, extra private fields, or mixins, you can list the
variant by name in the sealed class's `case` declaration and define the class separately:

```zena
sealed class Expr {
  case Lit, Add
}

final class Lit(value: i32) extends Expr

final class Add(left: Expr, right: Expr) extends Expr {
  eval(): i32 {
    return this.left.eval() + this.right.eval();
  }
}
```

The distributed class must:

1. Be declared in the same source file as the sealed class.
2. Explicitly extend the sealed class (`extends Expr`).
3. Be listed by name in the sealed class's `case` declaration.

### The closed hierarchy rule

Only classes declared in the same file and listed in the sealed class's `case` declaration
can extend the sealed class. Attempting to extend a sealed class from another file, or
without listing it in the `case` declaration, produces a compile error:

```zena
// In the same file:
class Multiply(left: Expr, right: Expr) extends Expr // Compile error: Multiply is not listed in Expr cases

// In another file:
import {Expr} from './expr';
class Sub(left: Expr, right: Expr) extends Expr      // Compile error: Cannot extend sealed class across modules
```

## Case class shorthand

A class declared with a parameter list immediately following its name is a **case class**:

```zena
class Point(x: f64, y: f64)
```

Case classes provide concise syntax for data-holding classes. The parameter list
simultaneously declares:

- Instance fields.
- A constructor initializing those fields.
- Value equality (`operator ==`).
- Hash code generation (`hashCode()`).

If the class needs no additional methods, the body and its braces can be omitted entirely.

### Parameter and field modifiers

Parameters in a case class define the mutability and nullability of the resulting fields:

#### Immutable fields (default)

Unadorned parameters create immutable fields (`let`):

```zena
class User(id: i32, name: String)

let u = new User(1, 'Ada');
u.name = 'Grace'; // Compile error: Cannot assign to immutable field
```

#### Mutable fields (`var`)

Prefixing a parameter with `var` declares a mutable field:

```zena
class Counter(name: String, var count: i32)

let c = new Counter('visits', 0);
c.count += 1; // OK: count is mutable
```

#### Default parameter values

Case class parameters can specify a default value with `=`:

```zena
class Node(value: i32, label: String? = null)

let n1 = new Node(42);           // label defaults to null
let n2 = new Node(42, 'root');   // label is 'root'
```

#### Combining modifiers

`var` and default values can be combined:

```zena
class Task(title: String, var assignee: String? = null)

let t = new Task('Deploy');
t.assignee = 'Alice';
```

### Case classes with bodies

Case classes can declare full class bodies for helper methods, custom accessors, and
static members:

```zena
class Point(x: f64, y: f64) {
  distanceTo(other: Point): f64 {
    let dx = this.x - other.x;
    let dy = this.y - other.y;
    return sqrt(dx * dx + dy * dy);
  }

  static origin = new Point(0.0, 0.0);
}
```

Inside the class body, the case parameters are accessible as instance fields on `this`:
`this.x` and `this.y`.

### Generics, inheritance, and interfaces

Case classes support type parameters, superclasses, mixins, and interface implementation:

```zena
class Pair<A, B>(first: A, second: B)

class Employee(id: i32, name: String, var role: String)
  extends Person(name)
  with Auditable
  implements Serializable
```

### Implicitly final

Standalone case classes are **implicitly final**: they cannot be extended by other
classes.

```zena
class Point(x: f64, y: f64)

class ColoredPoint extends Point { ... } // Compile error: Cannot extend final class 'Point'
```

This restriction ensures:

1. **Symmetric value equality**: If a subclass could add fields, equality comparisons
   between base and derived instances would either violate symmetry (`a == b !== b == a`)
   or break transitivity.
2. **WebAssembly GC optimization**: Marking the struct type `(sub final ...)` allows
   the WebAssembly engine to omit dynamic dispatch overhead and devirtualize method calls.

## Generated members

When you declare a case class or an inline case variant, the compiler automatically
synthesizes four key capabilities.

### 1. Constructor

The compiler generates a constructor matching the case parameter list:

```zena
class Entry(key: String, value: i32)

// Synthesized constructor behaves like:
// new(this.key, this.value);
```

If any parameters are marked optional (`?`), the constructor provides default `null`
values for those arguments.

### 2. Value equality (`operator ==`)

Standard Zena classes use reference identity (`===`) for the default `operator ==`. Two
different instances are not equal even if their field values match:

```zena
class StandardPoint {
  x: f64;
  y: f64;
  new(this.x, this.y);
}

let p1 = new StandardPoint(1.0, 2.0);
let p2 = new StandardPoint(1.0, 2.0);
let eq = p1 == p2; // false: different reference identities
```

In contrast, case classes automatically synthesize an `operator ==` that performs
field-by-field value comparison:

```zena
class CasePoint(x: f64, y: f64)

let cp1 = new CasePoint(1.0, 2.0);
let cp2 = new CasePoint(1.0, 2.0);
let eq = cp1 == cp2; // true: field values are equal
```

The synthesized equality method follows three steps:

1. **Identity check**: If `this === other`, return `true` immediately.
2. **Type check**: Verify that `other` is an instance of the exact same class (`other is Self`).
3. **Field comparison**: Compare each corresponding field. Primitive values are
   compared with `==`; reference values are compared by calling their own `==` operator.

### 3. Hash code (`hashCode()`)

Case classes automatically synthesize a `hashCode(): i32` method that combines the hash
codes of all fields using a deterministic hash mixing algorithm:

```zena
let p = new CasePoint(1.0, 2.0);
let hash = p.hashCode(); // Combines hash(1.0) and hash(2.0)
```

The hashing contract is strictly preserved: whenever `a == b` is `true`, `a.hashCode() == b.hashCode()`
is guaranteed to be `true`.

### 4. Implicit `Hashable` conformance

Classes in Zena generally require an explicit `implements Hashable` clause to be passed
to collections expecting hashable types:

```zena
interface Hashable {
  hashCode(): i32;
  operator ==(other: Hashable): boolean;
}
```

Case classes **implicitly conform to `Hashable`**. Because their `hashCode()` and
`operator ==` are guaranteed to exist and adhere to the hashing contract, they can be
used directly as keys in `HashMap<K, V>` or elements in `HashSet<T>` without an explicit
`implements Hashable` declaration:

```zena
import {HashSet} from 'zena:collections';

let points = new HashSet<CasePoint>();
points.add(new CasePoint(0.0, 0.0));
points.has(new CasePoint(0.0, 0.0)); // true
```

## Exhaustive matching

The primary way to consume sealed class hierarchies is using **`match` expressions**.
Because a sealed class's variants are completely known at compile time, the compiler
enforces **exhaustiveness checking**: every possible variant must be handled.

### Destructuring patterns

Patterns can inspect the variant type and destructure its fields in a single step:

```zena
let area = (shape: Shape): f64 => match (shape) {
  case Circle { radius }: 3.14159 * radius * radius
  case Rect { width, height }: width * height
};
```

You can rename destructured fields using `as`:

```zena
let describe = (shape: Shape): String => match (shape) {
  case Circle { radius as r }: `Circle with radius ${r}`
  case Rect { width as w, height as h }: `Rect with dimensions ${w}x${h}`
};
```

Empty braces `{}` match the variant type without binding any fields:

```zena
let isRound = (shape: Shape): boolean => match (shape) {
  case Circle {}: true
  case Rect {}: false
};
```

### Unit variant patterns

Unit variants are matched using bare identifier patterns:

```zena
let colorName = (color: Color): String => match (color) {
  case Red: 'red'
  case Green: 'green'
  case Blue: 'blue'
};
```

### Nested patterns

Patterns can match nested algebraic data structures:

```zena
sealed class Expr {
  case Lit(value: i32)
  case Add(left: Expr, right: Expr)
}

let simplify = (e: Expr): Expr => match (e) {
  // Add(Lit(0), x) -> x
  case Add { left: Lit { value: 0 }, right }: simplify(right)
  // Add(x, Lit(0)) -> x
  case Add { left, right: Lit { value: 0 } }: simplify(left)
  case Add { left, right }: new Add(simplify(left), simplify(right))
  case Lit {}: e
};
```

### Non-exhaustive match errors

If a `match` expression fails to cover all variants of a sealed class, the compiler
issues a diagnostic:

```zena
let describe = (shape: Shape): String => match (shape) {
  case Circle {}: 'circle'
  // Compile error: Non-exhaustive match. Missing: Rect
};
```

### Pattern guards and exhaustiveness

You can attach a boolean guard (`if condition`) to an arm:

```zena
let describe = (shape: Shape): String => match (shape) {
  case Circle { radius } if radius > 100.0: 'Large circle'
  case Circle {}: 'Small circle'
  case Rect { width, height }: 'Rectangle'
};
```

Guards evaluate arbitrary expressions at runtime, so the compiler cannot prove whether a
guarded pattern will match. Therefore, **a guarded pattern does not contribute to exhaustiveness**.
An unguarded fallback or remaining cases must still cover the type.

### Catch-all wildcards (`_`)

If you only need to handle specific variants, you can provide a wildcard arm (`case _:`)
to handle the remainder:

```zena
let isCircle = (shape: Shape): boolean => match (shape) {
  case Circle {}: true
  case _: false
};
```

Any pattern placed after an exhaustive set or wildcard arm is rejected as unreachable code:

```zena
let check = (shape: Shape): String => match (shape) {
  case _: 'any shape'
  case Circle {}: 'circle' // Compile error: Unreachable case
};
```

### Single-variant matching with `if let`

When you only care about one variant and do not need exhaustive handling of the rest,
use an `if let` pattern statement:

```zena
let printIfCircle = (shape: Shape): void => {
  if (let Circle { radius } = shape) {
    print(`Circle radius: ${radius}`);
  }
};
```
