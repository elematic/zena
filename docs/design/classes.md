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

  getTimestamp(): i32 {
    return this.timestamp;
  }
}

class User {
  name: string;
}

// Apply the mixin
class TimestampedUser extends Timestamped(User) {}
```

**Implementation Strategy:**
Mixins fit into the single-inheritance model by generating intermediate classes.

1.  **Compilation**: When `Timestamped(User)` is applied, the compiler generates a new concrete class (e.g., `$User_Timestamped`).
2.  **Struct Layout**: This new class struct contains all fields of `User` followed by fields of `Timestamped`.
3.  **Subtyping**: `$User_Timestamped` is declared as a subtype of `$User`.
    ```wat
    (type $User_Timestamped (sub $User (struct
       (field ... user fields ...)
       (field i32) ; timestamp
    )))
    ```
4.  **Chaining**: Multiple mixins (`A(B(C))`) create a linear inheritance chain `C -> B_C -> A_B_C`.

## 3. Method Dispatch

### 3.1. Static vs. Dynamic Dispatch

- **Static Dispatch**: The compiler hardcodes the function index to call (e.g., `call $Dog_speak`).
  - **Pros**: Fastest performance (direct jump, inlineable).
  - **Cons**: Cannot support polymorphism (overriding).
- **Dynamic Dispatch**: The function to call is determined at runtime based on the object's type.
  - **Pros**: Enables polymorphism (`animal.speak()` calls `Dog.speak()` if it's a Dog).
  - **Cons**: Slower (indirect jump via `call_ref`), harder to optimize.

### 3.2. VTables (Virtual Method Tables)

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

### 3.3. Method Call Process

To call `animal.speak()`:

1.  **Load VTable**: Get the VTable reference from `animal` (field 0).
2.  **Load Function**: Get the function reference from the VTable at the method's index (e.g., index 0 for `speak`).
3.  **Call**: Execute `call_ref` with the function reference, passing `animal` as `this`.

### 3.4. Devirtualization (Optimization)

The compiler will attempt to optimize dynamic dispatch to static dispatch whenever possible using **Static Analysis** and **Type Inference**.

- **Exact Type Known**: `let d = new Dog(); d.speak();` -> The compiler infers `d` is exactly `Dog` (not a subclass). Emits `call $Dog_speak`.
- **Final Classes**: If a class is marked `final` (cannot be extended), all calls on it can be static.
- **Sealed Classes**: If we know all subclasses, we might optimize.

### 3.5. Construction

When `new Dog()` is called:

1.  Allocate the `$Dog` struct.
2.  Initialize the VTable field with the singleton instance of `$Dog_VTable`.
3.  Run the constructor.

## 4. Interfaces (Future)

Interfaces allow polymorphism across unrelated class hierarchies. Since a class can implement multiple interfaces, we cannot rely on a single linear VTable (the method indices would conflict).

### 4.1. Implementation: Fat Pointers

We will likely use **Fat Pointers** to represent interface references.

- **Structure**: A tuple `(object_ref, itable_ref)`.
  - `object_ref`: The actual object instance.
  - `itable_ref`: A reference to an **Interface Table (ITable)** specific to that class's implementation of the interface.
- **ITable**: A struct containing function references for the interface's methods, mapped to the concrete class's implementations.

### 4.2. Dispatch

Interface calls are always **dynamically dispatched** (unless devirtualized).

1.  **Load ITable**: Get the ITable from the fat pointer.
2.  **Load Function**: Get the function reference from the ITable at the interface method's index.
3.  **Call**: Execute `call_ref`.

This approach avoids the "diamond problem" of multiple inheritance and keeps the object layout simple (only one VTable pointer).
