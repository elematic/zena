# Classes & Inheritance Design

This document details the implementation of Classes, Inheritance, and Polymorphism in Zena, targeting WASM-GC.

## 1. Class Representation

Classes in Zena are backed directly by **WASM GC Structs**.

### 1.1. Struct Layout

A class definition maps to a WASM struct type. Fields are laid out sequentially.

```typescript
class Point {
  x: i32;
  y: i32;
}
```

Compiles to:

```wat
(type $Point (struct
  (field (mut i32)) ; x
  (field (mut i32)) ; y
))
```

### 1.2. Methods

Methods are compiled as standalone WASM functions. The first parameter is always the instance (`this`).

```typescript
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

### 1.3. Member Access (`this`)

Accessing instance members (fields and methods) within a class requires the explicit `this` keyword (e.g., `this.x`).

**Rationale:**

- **Disambiguation**: It clearly differentiates instance members from local variables and module-scoped identifiers.
- **Shadowing**: It allows local variables to shadow fields without making the field inaccessible.
- **Module Access**: Crucially, it ensures that module-level variables are always accessible as bare identifiers. If `this` were optional, a class field named `log` would shadow an imported `log` function, making the import unreachable.

## 2. Inheritance

Zena supports single inheritance using the `extends` keyword.

### 2.1. Struct Subtyping

To support efficient casting and access, Zena ensures **Layout Compatibility**. A subclass struct must begin with the exact same fields (types and order) as its superclass.

```typescript
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

```typescript
// Define a mixin
mixin Timestamped(Base: Constructor) extends Base {
  timestamp: i32 = Date.now();
}
```

## 3. Accessors (Getters & Setters)

Zena uses a grouped accessor syntax, similar to C# or Swift. This groups the `get` and `set` operations under a single property declaration.

### 3.1. Syntax

Accessors are defined like fields but followed by a block `{}` containing `get` and/or `set` clauses.

```typescript
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

```typescript
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

```typescript
final class Point { ... }
```

- **Semantics**: `Point` cannot be subclassed.
- **Optimization**: All method calls on `Point` are statically dispatched (devirtualized).

### 5.2. Final Methods

```typescript
class Base {
  final compute(): i32 { ... }
}
```

- **Semantics**: `compute` cannot be overridden in subclasses.
- **Optimization**: Calls to `compute` on `Base` (or subclasses) are statically dispatched.

### 5.3. Final Fields

```typescript
class Base {
  final x: i32;
}
```

- **Semantics**: The virtual property `x` cannot be overridden by an accessor in a subclass.
- **Optimization**: Accessing `obj.x` is compiled to a direct struct field access (`struct.get`), bypassing the VTable getter/setter.
- **Note**: This does **not** mean the field is immutable (read-only). It means the _implementation_ of the field access is final. (Use `const` or `readonly` for immutability, if added).

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

```typescript
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

## 9. Protected Members

> **Note**: This feature is currently in the design phase and has not been implemented yet.

Zena supports protected members using the `_` prefix (e.g., `_render`).

### 9.1. Access Control Rules

Protected members are accessible in:

1.  **The defining class**.
2.  **Subclasses** (transitively).
3.  **The defining module** (file).

This "Module + Subclass" visibility allows framework code within the same module to orchestrate calls to protected methods (e.g., lifecycle hooks) without exposing them to the public API.

### 9.2. Inheritance & Namespaces

- **Shared Namespace**: Unlike private fields (`#`), protected fields (`_`) share the same namespace down the inheritance chain. A subclass can override a protected method.
- **No Collision**: Protected names in unrelated classes do not collide because access is resolved via the type system.
- **Mangling**: Protected members are **not** name-mangled like private fields. They behave like public fields but with restricted visibility during type checking.

### 9.3. Interfaces

Interfaces can declare protected methods.

- Implementing classes must provide the method (marked with `_`).
- The method is callable only by code with protected access to the interface (e.g., code in the same module as the interface definition).

### 9.4. Collision Handling (Qualified Names)

To avoid name collisions (e.g., when using Mixins or Interfaces that define the same protected name), Zena supports **Qualified Method Definitions**.

```typescript
class Widget extends Component {
  // Standard override (ambiguous if multiple bases have _render)
  override _render() { ... }

  // Qualified override (targets specific base/interface)
  Component._render() { ... }
}
```

**Accessing Qualified Members**:
To access a specific qualified member, use casting to the defining type.

```typescript
let w = new Widget();
(w as Component)._render(); // Calls the Component._render implementation
```

### 9.5. Super Calls

When overriding a protected method, you can call the superclass implementation using `super`. If the method is qualified (to resolve ambiguity), use a cast on `super` to specify which base class implementation to invoke.

```typescript
class Widget extends Component {
  Component._render() {
    // Call the specific base implementation
    (super as Component)._render();
  }
}
```

**Note on Syntax**: We chose `(super as T).method()` to maintain symmetry with instance access `(this as T).method()`.

- **Alternative Considered**: `super<T>.method()`.
  - _Pros_: Explicitly distinguishes "static ancestor call" from "cast".
  - _Cons_: Inconsistent with instance access. We cannot use `instance<T>.method()` for instances because it creates parsing ambiguities with comparison operators (e.g., `a < b`).

### 9.6. Static Symbols (Alternative Considered)

We considered using "Static Symbols" (similar to JavaScript Symbols or private declarations) to allow capability-based access control (e.g., `[_render]() { ... }`). However, we chose the `_` sigil for simplicity and performance, avoiding the need for computed property syntax or symbol management. The "Module Visibility" rule sufficiently covers the use case where a framework needs privileged access to a method it defines.
