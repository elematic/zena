# Classes & Inheritance Design

This document details the implementation of Classes, Inheritance, and Polymorphism in Zena, targeting WASM-GC.

## 1. Class Representation

Classes in Zena are backed directly by **WASM GC Structs**.

### 1.1. Struct Layout

A class definition maps to a WASM struct type. Fields are laid out sequentially.

```zena
class Point {
  x: i32;       // Mutable (default)
  let y: i32;   // Immutable
}
```

Compiles to:

```wat
(type $Point (struct
  (field (mut i32)) ; x - mutable
  (field i32)       ; y - immutable
))
```

### 1.2. Field Mutability

Fields in Zena are currently **mutable by default**. Use `let` to declare
immutable fields that can only be assigned during construction.

> **Future Direction**: The goal is to make fields **immutable by default**,
> requiring `var` for mutable fields. This matches Zena's philosophy of
> preferring immutability (like `let` bindings for variables). See
> [Migration to Immutable-by-Default](#migration-to-immutable-by-default) for
> the transition plan.

#### Syntax

```zena
class User {
  id: i32;                      // Mutable (default). Can be reassigned.
  let created: i64 = now();     // Immutable. Only assignable in constructor.
  var email: string;            // Explicit mutable (same as bare).
  var(#phone) phone: string;    // Mutable with private setter (public getter).
}
```

- **Bare or `var`**: Mutable field with public getter and setter.
- **`let`**: Immutable field. Only assignable in the constructor or initializer list.
- **`var(#name)`**: Mutable field with public getter but private setter. The
  setter is accessed via the private name (`this.#name = value`) inside the
  class.

#### Private Setter Semantics

The `var(#name)` syntax creates a field with:

- A **public getter** using the declared name
- A **private setter** using the specified private name

```zena
class Counter {
  var(#count) count: i32 = 0;

  increment() {
    this.#count = this.count + 1;  // Write via private name, read via public name
  }
}

let c = new Counter();
let n = c.count;    // OK - public getter
c.count = 5;        // Error: no public setter for 'count'
c.#count = 5;       // Error: #count is private to Counter
```

The setter name can also be a symbol for capability-based access control:

```zena
class Widget {
  var(:Framework.setState) state: State;  // Setter requires the symbol
}
```

#### Immutability and Construction

Immutable fields (`let`) can only be assigned in the constructor (directly or via
initializer lists). Attempting to assign to an immutable field outside the
constructor is a compile-time error:

```zena
class Point {
  let x: i32;
  let y: i32;

  #new(x: i32, y: i32) {
    this.x = x;  // OK - in constructor
    this.y = y;
  }

  move(dx: i32, dy: i32) {
    this.x = this.x + dx;  // Error: Cannot assign to immutable field 'x'
  }
}
```

#### WASM Representation

- **Immutable fields** compile to non-mutable WASM struct fields: `(field i32)`
- **Mutable fields** compile to mutable WASM struct fields: `(field (mut i32))`

This distinction enables WASM engines to apply optimizations like caching
immutable field values in registers across function calls.

#### Benefits of Immutable Fields

Beyond WASM-level optimizations, `let` fields enable additional compiler
features:

1. **Type Narrowing**: Immutable class fields can be narrowed after null checks.
   Since the field cannot be mutated between the check and use, narrowing is
   safe:

   ```zena
   class Wrapper {
     let inner: Container | null;
     #new() : inner = null { }
   }

   let process = (w: Wrapper): i32 => {
     if (w.inner !== null) {
       return w.inner.value;  // w.inner narrowed to Container
     }
     return 0;
   };
   ```

   Mutable (`var`) fields cannot be narrowed because another reference could
   modify the field between the check and use.

2. **Future**: Immutable fields may enable additional optimizations like
   compile-time constant propagation or more aggressive inlining.

### 1.3. Initializer Lists (Dart-style)

For truly immutable WASM fields, all values must be provided at allocation time
(WASM `struct.new` requires all field values upfront). This means `this` cannot
exist during initialization of immutable fields.

Zena supports **Dart-style initializer lists** for constructors to enable this:

```zena
class Point {
  let x: i32;
  let y: i32;

  // Initializer list: expressions before the body, no `this` access
  #new(x: i32, y: i32) : x = x, y = y { }
}
```

#### Syntax

```
#new(params) : field1 = expr1, field2 = expr2 { body }
```

- The colon (`:`) introduces the initializer list
- Each `field = expr` initializes a field
- Expressions can reference:
  - Constructor parameters
  - Earlier fields in the initializer list (by name, not `this.name`)
- Expressions **cannot** reference `this` (it doesn't exist yet)
- The body `{ }` runs after allocation with `this` available

#### Example: Computed Initialization

```zena
class Rectangle {
  let width: i32;
  let height: i32;
  let area: i32;

  #new(w: i32, h: i32) : width = w, height = h, area = w * h { }
}
```

#### Codegen Strategy

The initializer list enables true WASM immutability:

1. Evaluate each initializer expression into a local variable
2. Call `struct.new` with all field values
3. Store result in `this` local
4. Execute constructor body (if any)

```wat
;; Generated for Point#new(x: i32, y: i32)
(func $Point_new (param $x i32) (param $y i32) (result (ref $Point))
  (local $this (ref $Point))
  ;; No evaluation needed - params are already locals
  (local.set $this
    (struct.new $Point
      (local.get $x)    ; field 0: x
      (local.get $y)))  ; field 1: y
  (local.get $this))
```

#### Migration to Immutable-by-Default

The current default (mutable fields) will eventually change to immutable-by-default.
This section describes the incremental migration path.

##### Target State

Once migration is complete:

```zena
class User {
  id: i32;                      // Immutable (default). Only assignable in constructor.
  var email: string;            // Explicit mutable. Can be reassigned.
  var(#phone) phone: string;    // Mutable with private setter.
}
```

##### Migration Tools

The migration will be incremental, with multiple opt-in mechanisms:

1. **Compiler flag** (`--default-field-mutability`):

   ```bash
   # Current behavior (explicit during transition)
   zena build --default-field-mutability=mutable

   # Opt-in to new behavior
   zena build --default-field-mutability=immutable
   ```

2. **File-level pragma** (allows per-file migration):

   ```zena
   #[defaultFieldMutability: immutable]

   class Point {
     x: i32;  // Immutable due to pragma
     y: i32;
   }
   ```

3. **Warning mode** (lint before enforcing):

   ```bash
   # Warn on bare fields without explicit let/var
   zena build --warn-implicit-field-mutability
   ```

   This helps identify fields that need explicit modifiers before switching defaults.

4. **Test utilities** (for gradual test migration):
   ```typescript
   // In test utils
   const result = await compileAndRun(source, 'main', {
     defaultFieldMutability: 'immutable',
   });
   ```

##### Migration Steps

1. **Add explicit modifiers**: Run with `--warn-implicit-field-mutability` and
   add `let` or `var` to all fields.
2. **Test with new default**: Use `--default-field-mutability=immutable` to
   verify code works with the new default.
3. **Remove redundant modifiers**: Once immutable-by-default is active, `let`
   becomes optional (but can be kept for clarity).

### 1.4. Methods

Methods are compiled as standalone WASM functions. The first parameter is always the instance (`this`).

```zena
class Point {
  distance(): i32 { ... }
}
```

Compiles to:

```wat
(func $Point_distance (param $this (ref null $Point)) (result i32)
  ...
)
```

### 1.5. Member Access (`this`)

Accessing instance members (fields and methods) within a class requires the explicit `this` keyword (e.g., `this.x`).

**Rationale:**

- **Disambiguation**: It clearly differentiates instance members from local variables and module-scoped identifiers.
- **Shadowing**: It allows local variables to shadow fields without making the field inaccessible.
- **Module Access**: Crucially, it ensures that module-level variables are always accessible as bare identifiers. If `this` were optional, a class field named `log` would shadow an imported `log` function, making the import unreachable.

## 2. Inheritance

Zena supports single inheritance using the `extends` keyword.

### 2.1. Struct Subtyping

To support efficient casting and access, Zena ensures **Layout Compatibility**. A subclass struct must begin with the exact same fields (types and order) as its superclass.

```zena
class Point3D extends Point {
  z: i32;
}
```

Compiles to:

```wat
(type $Point3D (sub $Point (struct
  (field (mut i32)) ; x (Inherited)
  (field (mut i32)) ; y (Inherited)
  (field (mut i32)) ; z (New)
)))
```

The `(sub $Point ...)` declaration tells the WASM runtime that `$Point3D` is a subtype of `$Point`. This enables:

1.  Passing a `$Point3D` reference where a `$Point` is expected.
2.  Using `ref.cast` and `ref.test` for downcasting.

### 2.2. Field Access

Because of layout compatibility, accessing `p.x` works identically whether `p` is a `Point` or a `Point3D`. The field index for `x` is `0` in both structs.

### 2.3. Mixins

Zena supports Mixins as "Subclass Factories". This allows a class to inherit behavior from multiple sources by linearizing the inheritance chain.

We introduce a first-class `mixin` syntax that acts like a function taking a base class constructor.

```zena
// Define a mixin
mixin Timestamped(Base: Constructor) extends Base {
  timestamp: i32 = Date.now();
}
```

## 3. Accessors (Getters & Setters)

Zena uses a grouped accessor syntax, similar to C# or Swift. This groups the `get` and `set` operations under a single property declaration.

### 3.1. Syntax

Accessors are defined like fields but followed by a block `{}` containing `get` and/or `set` clauses.

```zena
class Circle {
  #radius: f64 = 0.0;

  // Grouped Accessor
  radius: f64 {
    get {
      return this.#radius;
    }
    set(v) {
      this.#radius = v;
    }
  }

  // Read-only accessor
  area: f64 {
    get {
      return this.#radius * this.#radius * 3.14159;
    }
  }
}
```

### 3.2. Semantics

- **Type Safety**: The property type (e.g., `radius: f64`) is the source of truth.
  - The `get` block must return a value of this type.
  - The `set` block receives a value of this type.
- **Grouping**: Allows decorators to apply to the property as a whole.
- **Implementation**: Compiled to methods (e.g., `Circle_get_radius`, `Circle_set_radius`).

### 3.3. Usage (Property Access)

Accessors are invoked using standard property access syntax (`obj.prop`), not method call syntax.

- **Read**: `let r = c.radius;` (Invokes the getter)
- **Write**: `c.radius = 10.0;` (Invokes the setter)

The compiler rewrites these property accesses into method calls to the underlying getter/setter functions.

### 3.4. Overriding Fields with Accessors

Zena supports overriding a plain field in a base class with an accessor in a subclass (and vice-versa). To support this uniformly, **all public fields are treated as virtual properties**.

#### Codegen Strategy

1.  **Base Class (`Base`)**:
    - Declaring a field `x: i32` generates:
      - A struct field (storage).
      - A default **getter method** that reads the struct field.
      - A default **setter method** that writes the struct field.
    - These accessor methods are added to the VTable.
2.  **Subclass (`Sub`)**:
    - Declaring an accessor `x: i32 { get { ... } }` generates:
      - A getter method with the custom logic.
    - The VTable for `Sub` is constructed using `Sub`'s getter instead of `Base`'s default getter.
    - **Note**: The storage slot for `x` (inherited from `Base`) still exists in `Sub`'s struct layout to maintain layout compatibility, even if the subclass accessor doesn't use it.

#### Performance Implication

Accessing a public field (`obj.x`) becomes a virtual call (`call_ref` via VTable) rather than a direct struct access (`struct.get`).

- **Optimization**: If the compiler can prove a class is `final` or the field is never overridden (e.g., via Whole Program Optimization), it can devirtualize the access to a direct `struct.get`.
- **Private Fields**: Private fields (`#x`) are never virtual and are always accessed directly.

## 4. Method Dispatch

### 4.1. Static vs. Dynamic Dispatch

- **Static Dispatch**: The compiler hardcodes the function index to call (e.g., `call $Dog_speak`).
  - **Pros**: Fastest performance (direct jump, inlineable).
  - **Cons**: Cannot support polymorphism (overriding).
- **Dynamic Dispatch**: The function to call is determined at runtime based on the object's type.
  - **Pros**: Enables polymorphism (`animal.speak()` calls `Dog.speak()` if it's a Dog).
  - **Cons**: Slower (indirect jump via `call_ref`), harder to optimize.

### 4.2. VTables (Virtual Method Tables)

We will implement dynamic dispatch using VTables.

1.  **VTable Struct**: A struct containing function references for all virtual methods.
2.  **Object Header**: Every object will have a hidden field (index 0) pointing to its class's VTable.

#### Example

```zena
class Animal {
  speak(): void { ... } // Index 0 in VTable
}

class Dog extends Animal {
  speak(): void { ... } // Overrides Index 0
  fetch(): void { ... } // Index 1
}
```

**Layouts:**

```wat
;; VTable Types
(type $Animal_VTable (struct (field (ref $Sig_Speak))))
(type $Dog_VTable    (struct (field (ref $Sig_Speak)) (field (ref $Sig_Fetch))))

;; Object Layouts
(type $Animal (struct
  (field (ref $Animal_VTable)) ; vtable pointer
  (field (mut i32))            ; other fields...
))

(type $Dog (struct
  (field (ref $Dog_VTable))    ; vtable pointer
  (field (mut i32))            ; inherited fields...
  (field (mut i32))            ; new fields...
))
```

### 4.3. Method Call Process

To call `animal.speak()`:

1.  **Load VTable**: Get the VTable reference from `animal` (field 0).
2.  **Load Function**: Get the function reference from the VTable at the method's index (e.g., index 0 for `speak`).
3.  **Call**: Execute `call_ref` with the function reference, passing `animal` as `this`.

### 4.4. Devirtualization (Optimization)

The compiler will attempt to optimize dynamic dispatch to static dispatch whenever possible using **Static Analysis** and **Type Inference**.

- **Exact Type Known**: `let d = new Dog(); d.speak();` -> The compiler infers `d` is exactly `Dog` (not a subclass). Emits `call $Dog_speak`.
- **Final Classes**: If a class is marked `final` (cannot be extended), all calls on it can be static.
- **Sealed Classes**: If we know all subclasses, we might optimize.

## 5. The `final` Modifier

To support manual optimization and enforce design intent, Zena supports the `final` modifier.

### 5.1. Final Classes

```zena
final class Point { ... }
```

- **Semantics**: `Point` cannot be subclassed.
- **Optimization**: All method calls on `Point` are statically dispatched (devirtualized).

### 5.2. Final Methods

```zena
class Base {
  final compute(): i32 { ... }
}
```

- **Semantics**: `compute` cannot be overridden in subclasses.
- **Optimization**: Calls to `compute` on `Base` (or subclasses) are statically dispatched.

### 5.3. Final Fields

```zena
class Base {
  final var x: i32;
}
```

- **Semantics**: The virtual property `x` cannot be overridden by an accessor in a subclass.
- **Optimization**: Accessing `obj.x` is compiled to a direct struct field access (`struct.get`/`struct.set`), bypassing the VTable getter/setter.
- **Note**: `final` controls **overridability**, not **mutability**. A `final var` field can still be mutated; a `final` (immutable) field cannot be mutated but could theoretically be overridden by an accessor. Use both `final` and immutability (`let` or bare) together for a field that is both non-overridable and read-only.

```zena
class Config {
  final apiUrl: string;        // Immutable + non-overridable (optimal)
  final var retryCount: i32;   // Mutable + non-overridable
  var(#value) value: i32;      // Immutable public, mutable private, overridable
}
```

## 6. Construction

When `new Dog()` is called:

1.  Allocate the `$Dog` struct.
2.  Initialize the VTable field with the singleton instance of `$Dog_VTable`.
3.  Run the constructor.

## 7. Interfaces (Future)

Interfaces allow polymorphism across unrelated class hierarchies. Since a class can implement multiple interfaces, we cannot rely on a single linear VTable (the method indices would conflict).

### 7.1. Implementation: Fat Pointers

We will likely use **Fat Pointers** to represent interface references.

- **Structure**: A tuple `(object_ref, itable_ref)`.
  - `object_ref`: The actual object instance.
  - `itable_ref`: A reference to an **Interface Table (ITable)** specific to that class's implementation of the interface.
- **ITable**: A struct containing function references for the interface's methods, mapped to the concrete class's implementations.

### 7.2. Dispatch

Interface calls are always **dynamically dispatched** (unless devirtualized).

1.  **Load ITable**: Get the ITable from the fat pointer.
2.  **Load Function**: Get the function reference from the ITable at the interface method's index.
3.  **Call**: Execute `call_ref`.

This approach avoids the "diamond problem" of multiple inheritance and keeps the object layout simple (only one VTable pointer).

## 8. Private Fields

Zena supports private fields using the `#` prefix (e.g., `#count`).

### 8.1. Access Control

Private fields are only accessible within the class body where they are defined. This is enforced at compile-time by the Type Checker. Accessing a private field from outside the class or from a subclass results in a compilation error.

### 8.2. Implementation

Private fields are implemented using **Name Mangling** to ensure uniqueness and prevent collisions with fields in subclasses.

- **Mangling Scheme**: A private field `#x` in class `Point` is internally mapped to the name `Point::#x`.
- **Struct Layout**: In the generated WASM struct, private fields are laid out alongside public fields. The mangled name is used only during compilation to resolve the correct field index.

```zena
class A {
  #x: i32; // Mapped to "A::#x"
}

class B extends A {
  #x: i32; // Mapped to "B::#x" - No collision with A's #x
}
```

TODO: Once we allow type aliasing and support modules we could have
multiple classes with the same name in a inheritance chain and get
private name collisions.

## 9. Static Symbols (Protocol Methods)

Zena supports **Static Symbols** to define "protocol" or "system" methods that are not part of the public name-based API. This replaces the traditional "protected" visibility modifier with a capability-based access control model similar to JavaScript Symbols, but statically resolved for zero-cost abstraction.

### 9.1. Motivation

Sometimes APIs need to expose methods for system use (e.g., iteration, serialization) or for advanced users, without cluttering the public auto-complete namespace or risking name collisions.

### 9.2. Defining Symbols

Symbols are declared using the `symbol` keyword. They can be top-level constants or static members of classes/interfaces.

```zena
// Top-level symbol
export symbol mySymbol;

// Static member symbol (Recommended for Interfaces)
interface Iterable<T> {
  static symbol iterator;

  // Method definition using the symbol
  [Iterable.iterator](): Iterator<T>;
}
```

### 9.3. Implementing & Calling Symbols

To define or call a symbol-keyed method, use the bracket syntax `[sym]`.

```zena
class MyList<T> implements Iterable<T> {
  // Implementation
  [Iterable.iterator](): Iterator<T> {
    return new MyIterator(this);
  }
}

// Usage
let list = new MyList();
// list.iterator(); // Error: No such method
let it = list[Iterable.iterator](); // OK
```

### 9.4. Semantics & Compilation

- **Static Resolution**: Unlike JavaScript, Zena symbols are resolved at **compile time**. The compiler maps each symbol to a unique VTable index.
- **No Dynamic Lookup**: The expression inside `[...]` must be a compile-time constant resolving to a symbol. Dynamic expressions like `list[getRandomSymbol()]()` are **not supported** to ensure performance and AOT compatibility.
- **Access Control**: Visibility is controlled via standard `export` rules. If you don't export the symbol, outside modules cannot call or implement the method.

### 9.5. Comparison to "Protected"

- **Flexibility**: Symbols can be shared across unrelated libraries (if the symbol itself is shared), allowing for "friend" access patterns beyond just subclasses.
- **No Collisions**: Two interfaces can define methods with the same _name_ but different _symbols_, allowing a class to implement both without conflict.

## 10. Initialization & Safety

### 10.1. Initialization Hazards

A common issue in object-oriented languages is the "Initialization Hazard". This occurs when a superclass constructor calls a virtual method that is overridden by a subclass. If the subclass implementation accesses fields that haven't been initialized yet (because the subclass constructor hasn't run), the program may crash or behave unpredictably.

### 10.2. Construction Rules

To mitigate these hazards, Zena enforces strict rules on constructor implementation:

1.  **Mandatory Super Call**: Constructors in derived classes MUST call `super()`.
2.  **No `this` Before Super**: Accessing `this` (implicitly or explicitly) before the `super()` call is a compile-time error.
3.  **Field Initialization Order**:
    - Fields with initializers (e.g., `x: i32 = 10`) are initialized **immediately after** the `super()` call returns.
    - This ensures that when the constructor body continues after `super()`, the instance is fully initialized (both superclass and subclass fields).
4.  **Field Initializer Safety**:
    - Initializers are executed in source order.
    - Accessing a field declared later in the same class is a **compile-time error**.
    - `this` is accessible, and accessing inherited fields is allowed.

### 10.3. Remaining Hazards (Soundness Hole)

While these rules prevent accessing uninitialized fields _within the subclass constructor_, they do **not** prevent the "Virtual Call from Super Constructor" hazard.

If a superclass constructor calls a virtual method overridden by the subclass, that method will execute _before_ the subclass fields are initialized (because `super()` is still running).

**This is a known hole in the type system's soundness.**

- **Violation**: A field declared as non-nullable (e.g., `x: String`) is technically `null` during this window.
- **Consequence**: If the overridden method accesses `this.x`, it will observe `null`. Attempting to use it (e.g., `this.x.length`) will cause a runtime trap (Null Pointer Exception), violating the static type guarantee.

```zena
class Base {
  #new() {
    this.setup(); // Virtual call
  }
  setup() {}
}

class Sub extends Base {
  data: String = 'hello'; // Non-nullable String
  #new() {
    super(); // Calls Base constructor -> calls setup() -> accesses uninitialized data!
  }
  override setup() {
    // Runtime Error: Null Pointer Exception (trap)
    // despite 'data' being typed as non-nullable String.
    console.log(this.data.length);
  }
}
```

### 10.4. Potential Solutions

To close this soundness hole, we are considering several approaches:

1.  **Pre-Super Initialization (Dart, Swift)**
    - **Mechanism**: Initialize subclass fields _before_ calling `super()`.
    - **Pros**: The subclass fields are fully initialized when the super constructor runs. Virtual calls see valid data.
    - **Cons**: Field initializers cannot access `this` or inherited fields (because the superclass isn't initialized yet). This restricts patterns like `x = this.y + 1`.

2.  **Ban Virtual Calls in Constructors**
    - **Mechanism**: Statically prevent calling virtual methods on `this` during construction.
    - **Pros**: Prevents the hazard entirely.
    - **Cons**: Difficult to enforce across module boundaries (requires analyzing the call graph of the super constructor).

3.  **Masking / Flow Typing**
    - **Mechanism**: Treat all fields as potentially `null` within the constructor until they are proven initialized.
    - **Pros**: Type-safe.
    - **Cons**: Increases complexity for the user (must handle nulls) and the compiler (flow analysis).

4.  **Object Slicing (C++)**
    - **Mechanism**: During `Base` construction, the object's VTable points to `Base`, not `Derived`. Virtual calls execute `Base`'s implementation.
    - **Pros**: Safe (no uninitialized derived fields accessed).
    - **Cons**: Confusing behavior (polymorphism is temporarily disabled).

5.  **Enhanced Pre-Super Initialization (Hybrid)**
    - **Mechanism**: Allow initializing fields before `super()`, with restricted access to `this`.
      - Can read fields that are provably initialized earlier in the same class.
      - Cannot read inherited fields (super not initialized).
      - Cannot call virtual methods or pass `this` externally (escape analysis).
    - **Pros**: Solves the hazard while allowing more expressive initialization than strict pre-super checks.
    - **Cons**: Complex to implement (requires tracking initialization state and restricted `this` usage).

Zena currently allows this pattern but warns users to avoid calling virtual methods in constructors. Future versions may introduce stricter checks or "Two-Phase Initialization" to prevent this.
