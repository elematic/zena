---
title: 'Type Testing and Narrowing'
description: 'Runtime type inspection, explicit casting, and control-flow-based type narrowing in Zena.'
---

Zena is a statically typed language with a sound type system targeting
WebAssembly GC. There is no `any` type, no implicit type coercion, and no
unchecked downcasts.

To support dynamic polymorphism, untagged union types, and nullable references
while maintaining soundness, Zena provides three tightly integrated features:

1. **The `is` operator**: Evaluates at runtime whether an expression conforms to
   a specific type, returning a `boolean`.
2. **The `as` operator**: Performs checked downcasts, explicit numeric
   conversions, zero-cost distinct type casts, and interface adaptations.
3. **Control-flow narrowing**: Statically refines variable types across
   branches, logical conditions (`&&`, `||`), loops, and early-exit paths
   without requiring boilerplate manual casts.

## The is operator

The `is` operator performs a runtime type check on an expression.

### Syntax and return value

```zena
expression is TargetType
```

The `is` operator always returns a primitive `boolean` (`true` or `false`). It
never throws an exception or causes a runtime trap.

### Class hierarchy checks

When testing class instances, `is` verifies whether the instance is of the
specified class or any of its subclasses. This compiles directly to the
WebAssembly GC `ref.test` instruction:

```zena
class Animal {}

class Dog extends Animal {
  bark(): String { return 'woof'; }
}

class Cat extends Animal {
  meow(): String { return 'meow'; }
}

let pet: Animal = new Dog();

pet is Dog;    // true
pet is Cat;    // false
pet is Animal; // true
```

### Null handling

`null` is not an instance of any non-nullable class or interface. Testing `null`
against a non-nullable type always yields `false`:

```zena
let maybePet: Animal? = null;

maybePet is Animal; // false
maybePet is Dog;    // false
```

Testing against a nullable type is also supported:

```zena
maybePet is Animal?; // true
```

### Reified generics at runtime

Unlike languages where generic type arguments are erased at runtime (such as
TypeScript or Java), Zena compiles to WebAssembly GC with **reified generics**.
Each generic specialization possesses its own distinct runtime type descriptor.

This means generic type arguments are fully testable with `is`:

```zena
class Box<T> {
  value: T;
  new(this.value);
}

let a: anyref = new Box<i32>(42);
let b: anyref = new Box<String>('hello');

a is Box<i32>;    // true
a is Box<String>; // false

b is Box<String>; // true
b is Box<i32>;    // false
```

### Testing through interfaces

In Zena, an object held as an interface is represented as a fat pointer
containing the underlying instance paired with the interface vtable.

The `is` operator inspects the underlying concrete instance through the
interface fat pointer:

```zena
interface Shape {
  area(): f64;
}

class Circle implements Shape {
  radius: f64;
  new(this.radius);
  area(): f64 { return 3.14159 * this.radius * this.radius; }
}

class Square implements Shape {
  side: f64;
  new(this.side);
  area(): f64 { return this.side * this.side; }
}

let shape: Shape = new Circle(5.0);

shape is Circle; // true
shape is Square; // false
```

Generic specializations also survive through interfaces: testing `shape is
Cell<i32>` accurately discriminates between `Cell<i32>` and `Cell<String>`.

### Discriminating union types

The `is` operator is the primary mechanism for inspecting and discriminating
untagged union types:

```zena
class Success {
  data: String;
  new(this.data);
}

class Failure {
  error: String;
  new(this.error);
}

type Result = Success | Failure;

function handle(r: Result): void {
  if (r is Success) {
    println('Success: ' + r.data);
  } else {
    println('Error: ' + r.error);
  }
}
```

### Primitives and anyref

Zena does not perform implicit boxing. Primitive values (`i32`, `i64`, `f32`,
`f64`, `boolean`) are unboxed scalars and cannot be directly assigned to
`anyref`.

To test a primitive value behind a generic reference, it must be explicitly
boxed using `Box<T>` from `zena:core`:

```zena
import { Box } from 'zena:core';

let boxed: anyref = new Box<i32>(100);

boxed is Box<i32>; // true
boxed is Box<f64>; // false
```

Direct primitive type tests (e.g. `x is i32`) are evaluated statically by the
compiler when `x` is already a primitive.

## The as operator

The `as` operator performs explicit type conversions, downcasts, and static type
assertions.

### Syntax

```zena
expression as TargetType
```

Zena has no unchecked casts. Every cast with `as` is either validated statically
at compile time or compiled into a checked runtime operation that will **trap**
if the cast is invalid.

### Reference downcasting and runtime traps

Downcasting converts a reference from a broader type (such as a superclass,
interface, or `anyref`) to a more specific subtype:

```zena
class Animal {
  name: String;
  new(this.name);
}

class Dog extends Animal {
  bark(): void { println('woof'); }
  new(name: String) : super(name) {}
}

let a: Animal = new Dog('Rex');
let d = a as Dog; // Compiles to WebAssembly ref.cast
d.bark();
```

::: warning Runtime traps on failed downcasts

If the runtime value does not match the target type, the WebAssembly `ref.cast`
instruction immediately raises an unrecoverable **runtime trap**:

```zena
let a: Animal = new Animal('Generic');
let d = a as Dog; // Traps: RuntimeError: illegal cast
```

Because Zena features **control-flow narrowing**, you rarely need explicit
downcasts after a runtime type check. Testing `if (a is Dog)` or
pattern-matching in `match (a)` automatically narrows `a` to `Dog` across the
guarded scope without writing a cast. Writing `a as Dog` after an `is Dog` check
is redundant and can trigger an unnecessary-cast compiler warning.

Explicit downcasts are primarily useful when control-flow narrowing cannot see
the relationship between types or cannot prove safety:

- **Heterogeneous storage and registries**: Retrieving a value from an `anyref`
  collection, cache, or event bus where an external key guarantees the concrete
  type (`let handler = registry.get(id) as ClickHandler`).
- **Un-narrowable mutable paths**: Reading from a mutable (`var`) field or
  complex getter where the compiler cannot guarantee the field hasn't mutated
  since a previous check.
- **Correlated types and external invariants**: When two separate values have an
  application-level relationship that is not directly modeled as a discriminated
  union (for example, receiving an untyped message payload whose schema is
  governed by a separate protocol header).

:::

### Compile-time upcasting

Upcasting moves from a more specific type to a broader type (such as casting a
subclass to its superclass, or to an interface):

```zena
let d = new Dog('Rex');
let a = d as Animal; // Zero cost: upcast validated at compile time
```

Because upcasts are guaranteed safe by the type hierarchy, the compiler elides
them at runtime, incurring zero performance penalty.

### Numeric conversions

Zena enforces strict type isolation between numeric types. There is no implicit
widening or narrowing between different integer or float types (with the sole
exception of `i32 + f32 -> f32` in binary arithmetic).

All numeric conversions require explicit `as` casts:

| Conversion              | Target Type         | Behavior                             | Example                           |
| :---------------------- | :------------------ | :----------------------------------- | :-------------------------------- |
| `i32` to `i64`          | Widening integer    | Sign-extended to 64 bits             | `42 as i64`                       |
| `i64` to `i32`          | Narrowing integer   | Truncated to low 32 bits             | `x as i32`                        |
| `i32` to `f32` / `f64`  | Int to float        | Numerical conversion                 | `10 as f64`                       |
| `f64` to `i32` / `i64`  | Float to int        | Truncates toward zero                | `3.99 as i32` (yields `3`)        |
| `i32` <-> `u32`         | Signed <-> Unsigned | Bit reinterpretation (zero cost)     | `-1 as u32` (yields `4294967295`) |
| Integer to `u8` / `u16` | Byte / Short        | Truncates to low bits, zero-extended | `300 as u8` (yields `44`)         |
| Integer to `i8` / `i16` | Signed Byte / Short | Truncates to low bits, sign-extended | `200 as i8` (yields `-56`)        |

### Distinct types and opaque types

Distinct types (`distinct type ID = i32;`) create nominal type wrappers over
existing underlying types:

```zena
distinct type UserID = i32;

let id: UserID = 101 as UserID; // Wrap: zero-cost compile-time check
let raw: i32 = id as i32;       // Unwrap: zero-cost compile-time check
```

Casting between a distinct type and its underlying representation is checked at
compile time and elided at runtime.

**Opaque types** (`distinct type OpaqueID = i32;` inside an export boundary)
enforce encapsulation: outside the defining module, an opaque type cannot be
forged by casting from the primitive type.

### Contextual typing via as

When casting an expression literal to a reference type, the `as` operator
provides a **contextual type** to the operand:

```zena
let names = [] as Array<String>; // Informs [] that its element type is String
```

Without the cast, an empty array literal `[]` has no inferable element type.

In contrast, casting a primitive value is a conversion rather than contextual
typing: `-1 as u32` preserves `-1` as an `i32` scalar and reinterprets its bit
pattern as an unsigned 32-bit integer.

### Disallowed casts and compiler diagnostics

The compiler rejects unsafe or meaningless casts at compile time:

1. **Primitive to Reference (and vice versa)**:

   ```zena
   let s = 123 as String; // Compile error: Cannot cast primitive type 'i32' to reference type 'String'.
   let n = obj as i32;    // Compile error: Cannot cast reference type to primitive type.
   ```

   To convert a number to a string, use string interpolation (`'${x}'`) or a
   formatting function. To read a primitive from a heap object, access its
   unboxed field (e.g. `(obj as Box<i32>).value`).

2. **Union Types as Cast Targets**:

   ```zena
   let pet = animal as (Dog | Cat); // Compile error: Cannot use union type as cast target.
   ```

   A cast must name a concrete, single type.

3. **Unnecessary Cast Warnings**: When the `ZENA_WARN_UNNECESSARY_CASTS`
   environment variable is set, casting an expression to a type it already
   possesses emits a compiler warning (`zena lint` reports these too):
   ```zena
   let x: i32 = 10;
   let y = x as i32; // Warning: Unnecessary cast: expression is already of type 'i32'.
   ```

## Control-flow narrowing

**Control-flow narrowing** (also known as flow-sensitive typing) is the
automatic refinement of an expression's static type based on runtime guards and
code execution paths.

Rather than forcing developers to manually cast variables with `as`, the Zena
compiler tracks conditions across the control-flow graph (CFG) and automatically
updates variable types in branches where those conditions hold true.

### Equality and literal type discrimination

In Zena, `null` is not an ad-hoc language quirk—it is a **literal type**
inhabited solely by the single value `null`. A nullable type `String?` is simply
an untagged union: `String | null`.

Because `null` has only one possible value, it is a **unit type**. For any unit
type, testing value equality (`==`) is logically identical to testing type
membership:

```zena
function printLength(text: String?): void {
  if (text != null) {
    // 'null' is subtracted from String | null; 'text' is narrowed to String
    println(text.length);
  } else {
    // 'text' is narrowed to null
  }
}
```

The compiler recognizes all standard equality comparisons:

- `x !== null` and `x != null` (narrows to non-null in the `true` branch, `null`
  in the `else` branch).
- `x === null` and `x == null` (narrows to `null` in the `true` branch, non-null
  in the `else` branch).
- Reversed operand order (`null !== x`, `null == x`).

#### Unit types and sealed cases

The equivalence of equality and type membership extends directly to **unit
variants** in sealed class hierarchies (cases declared without fields):

```zena
sealed class Option {
  case Some(value: i32)
  case None
}
```

Unit variants like `None` have no state and are allocated as runtime singletons.
Because only one instance exists:

- `opt is None` tests whether `opt` is an instance of subclass `None`.
- `opt == None` tests whether `opt` is reference-equal to the singleton `None`.

Both evaluate to the exact same result. The compiler narrows `opt` to `None` in
the `true` branch, and eliminates `None` from the union in the `else` branch.

#### Discriminating literal unions

Equality narrowing applies to any union of literal types. Testing against a
specific value eliminates all alternative literal values:

```zena
type Mode = 'read' | 'write' | 'append';

function configure(mode: Mode): void {
  if (mode == 'read') {
    // 'mode' is narrowed to 'read'
    setReadOnly();
  } else {
    // 'read' is eliminated; 'mode' is narrowed to 'write' | 'append'
    setWritable();
  }
}
```

### Type discrimination with is

When a variable has a union type of classes or interfaces, testing with `is`
narrows the variable to the tested type in the `true` branch, and eliminates
that type from the union in the `else` branch:

```zena
class Cat {
  meow(): String { return 'meow'; }
}

class Dog {
  bark(): String { return 'woof'; }
}

function speak(pet: Cat | Dog): String {
  if (pet is Cat) {
    // 'pet' is narrowed to Cat
    return pet.meow();
  } else {
    // Cat is eliminated; 'pet' is narrowed to Dog
    return pet.bark();
  }
}
```

If a union contains three or more types (`Cat | Dog | Bird`), checking `pet is
Cat` leaves `pet` as `Dog | Bird` in the `else` branch.

### Pattern matching with match()

Zena's `match` expression provides exhaustive pattern matching. Each `case` arm
establishes a narrowed flow path for the discriminant variable (as well as
immutable member paths):

```zena
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}

function calculateArea(s: Shape): f64 {
  return match (s) {
    case Circle {radius}: {
      // 's' is narrowed to Circle; 'radius' is extracted
      3.14159 * radius * radius
    }
    case Rect {width, height}: {
      // 's' is narrowed to Rect; 'width' and 'height' are extracted
      width * height
    }
  };
}
```

Narrowing in `match` expressions also applies to:

- **Untagged unions**: Matching `case Cat:` in `match (pet: Cat | Dog)` narrows
  `pet` to `Cat`.
- **Unit variants**: Matching `case None:` or `case Red:` matches the singleton
  variant.
- **Immutable member paths**: `match (holder.shape)` narrows `holder.shape`
  inside each case arm.

### Pattern narrowing with if let and while let

Zena supports refutable pattern matching in conditional statements via `if (let
pattern = expr)` and `while (let pattern = expr)`.

The compiler analyzes the destructuring pattern and narrows the bound variables
to the specific types of the matched variant.

#### Tagged inline tuple unions (Map.get and Iterator.next)

Standard library operations such as `Map.get(key)` and `Iterator.next()` return
unboxed, zero-cost **inline tuple unions**:

- **`Map.get(key)`** returns `inline (true, V) | inline (false, _)` -
  **`Iterator.next()`** returns `inline (true, T) | inline (false, _)`

When destructuring these unions with a pattern containing a literal `true` tag,
the compiler's `narrowTypeByPattern` analysis filters out the `(false, _)`
variant. As a result, the payload variable in position 1 is automatically
narrowed to the actual value type (excluding the hole `_`):

```zena
import { Map } from 'zena:collections';

let users = new Map<String, User>();

// Map.get returns inline (true, User) | inline (false, _)
if (let (true, user) = users.get('alice')) {
  // Matching literal 'true' eliminates the (false, _) variant.
  // 'user' is narrowed to User (not User | _).
  println('Found user: ' + user.name);
} else {
  println('User not found');
}
```

The same pattern narrowing powers zero-allocation stream and generator iteration
using `while (let ...)`:

```zena
function drainIterator<T>(iter: Iterator<T>): void {
  // Iterator.next returns inline (true, T) | inline (false, _)
  while (let (true, item) = iter.next()) {
    // 'item' is narrowed to T for each iteration
    processItem(item);
  }
  // Loop exits when iter.next() returns (false, _)
}
```

This pattern enables expressive, zero-allocation optional and fallible returns
without requiring heap-allocated `Option` or `Result` wrapper objects.

#### Class destructuring with if let

`if let` similarly discriminates sealed class variants:

```zena
sealed class Option<T> {
  case Some(value: T)
  case None
}

function inspect(opt: Option<i32>): void {
  if (let Some {value} = opt) {
    // 'value' is bound with type i32
    println('Value: ' + value);
  }
}
```

### Logical operators and compound conditions

The type checker analyzes logical expressions from left to right:

#### Logical AND (&&)

In an `&&` chain, each condition narrows the type for subsequent conditions in
the same expression and for the guarded body:

```zena
class Inner(value: String)
class Outer(inner: Inner?)

function getLength(outer: Outer?): i32 {
  // 'outer' is narrowed first; then 'outer.inner' can be checked
  if (outer != null && outer.inner != null) {
    return outer.inner.value.length;
  }
  return 0;
}
```

#### Logical OR (||)

When alternatives are joined with `||`, the types from all branches are combined
into a narrowed union:

```zena
function inspect(pet: Cat | Dog | Bird): void {
  if (pet is Cat || pet is Dog) {
    // 'pet' is narrowed to Cat | Dog
    handleMammal(pet);
  } else {
    // Both Cat and Dog eliminated; 'pet' is narrowed to Bird
    handleBird(pet);
  }
}
```

#### Conditional (if) expressions

Narrowing applies identically inside expressions:

```zena
let length = if (str != null) str.length else 0;
```

### Loops and flow inversion

Narrowing is computed on the control-flow graph (CFG), enabling precise tracking
across loops:

#### Loop condition guards

Variables in `while` loop conditions are narrowed throughout the loop body:

```zena
function processChain(start: Node?): i32 {
  var current = start;
  var sum = 0;
  while (current != null) {
    sum += current.value; // 'current' is narrowed to Node
    current = current.next;
  }
  return sum;
}
```

#### Post-loop condition inversion

When a loop terminates, the compiler knows the loop condition must have
evaluated to `false`. If the loop condition checked for null or equality, that
inversion holds after the loop:

```zena
function waitForNode(): Node {
  var node: Node? = null;
  while (node == null) {
    node = fetchNext();
  }
  // The loop only exits when node != null:
  return node; // 'node' is narrowed to Node!
}
```

### Early exit and never-returning calls

When a branch terminates execution through `return`, `throw`, or a call to a
function that returns the bottom type `never` (such as `panic()` or an
error-throwing helper), execution cannot continue along that path.

The compiler applies the inverted condition to all subsequent code in the outer
scope:

```zena
function fail(message: String): never {
  throw new Error(message);
}

function processUser(user: User?): String {
  if (user == null) {
    fail('User must not be null');
  }

  // The null path never returns, so 'user' is narrowed to User here:
  return user.name;
}
```

This pattern eliminates deep `if-else` nesting in favor of early guard clauses.

### Path narrowing: variables and members

Zena narrows both bare variable identifiers and paths through immutable data
structures:

#### Immutable variables (let)

Variables declared with `let` are immutable. Once narrowed, their narrowed type
persists for the entire scope of the guard.

#### Mutable variables (var) and reassignment invalidation

Variables declared with `var` can be modified. When a `var` binding is
reassigned:

- If the newly assigned value **satisfies** the narrowed type, the narrowing
  survives.
- If the newly assigned value **does not satisfy** the narrowed type (e.g.
  assigning a nullable value back to a narrowed non-null variable), the
  narrowing is invalidated and the variable widens back to its declared type:

```zena
function update(box: Box?): i32 {
  var b = box;
  if (b != null) {
    println(b.value); // OK: b is narrowed to Box

    b = fetchMaybeBox(); // May return null
    // println(b.value); // Compile error: Object may be null!

    b = new Box(42);    // Always non-null
    println(b.value);   // OK: narrowed back to Box
  }
  return 0;
}
```

#### Immutable paths (let fields, records, tuples)

Narrowing safely extends to member accesses when every segment of the path is
immutable:

- **`let` class fields**: Cannot be reassigned after construction.
- **Record fields**: Always immutable in Zena (`{x: 10, y: 20}`).
- **Tuple elements**: Always immutable in Zena (`(node, 42)`).

```zena
class Container {
  let inner: Node?;
  new(this.inner);
}

function read(c: Container, r: {item: Node?}, t: (Node?, i32)): i32 {
  var sum = 0;
  if (c.inner != null) {
    sum += c.inner.value; // c.inner narrowed to Node
  }
  if (r.item != null) {
    sum += r.item.value;  // r.item narrowed to Node
  }
  if (t[0] != null) {
    sum += t[0].value;    // t[0] narrowed to Node
  }
  return sum;
}
```

#### Why mutable fields (var) cannot be narrowed

Fields declared with `var` cannot be narrowed across control flow because
another alias, a concurrent task, or a helper method could modify the field
between the check and its usage:

```zena
class MutableContainer {
  var inner: Node? = null;
}

function process(c: MutableContainer): i32 {
  if (c.inner != null) {
    // Error: Cannot narrow mutable field 'inner'.
    // Another reference could set c.inner = null here.
    return c.inner.value;
  }
  return 0;
}
```

**Idiom: Local binding**: To safely narrow a mutable field, copy it into a local
`let` binding first:

```zena
function process(c: MutableContainer): i32 {
  let inner = c.inner;
  if (inner != null) {
    return inner.value; // OK: local 'inner' is immutable and narrowed
  }
  return 0;
}
```

### Narrowing from `requires` clauses

An unmarked `requires (condition)` precondition on a function, arrow, method, or
constructor narrows types using the same flow rules as `if (condition)`. Any
refinement established in a `requires` clause holds in subsequent clauses and
throughout the function body:

```zena
function firstChar(text: String | null): i32
  requires (text != null && text.length > 0)
{
  // `text` is narrowed to `String` here
  return text.getByteAt(0);
}
```

As with `if`, immutable parameters, `let` bindings, and immutable field paths
narrow, while mutable `var` fields do not. Clauses marked `debug requires` never
narrow types because they are omitted outside `zena test` and `--debug` (`-g`)
builds. See [Contracts](/reference/contracts/#type-checking-and-narrowing).
