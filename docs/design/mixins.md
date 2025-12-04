# Mixins Design

## 1. Overview

Mixins in Zena provide a way to reuse code across multiple class hierarchies. They are "subclass factories" or "abstract subclasses" that can be applied to various base classes.

## 2. Syntax

### 2.1. Defining a Mixin

Mixins are defined using the `mixin` keyword. They look similar to classes but cannot be instantiated directly.

```zena
mixin Timestamped {
  timestamp: i32 = Date.now();

  getAge(): i32 {
    return Date.now() - this.timestamp;
  }
}
```

### 2.2. Applying Mixins

Mixins are applied to a class using the `with` keyword in the `class` declaration.

```zena
class User {
  name: string;
}

class RegisteredUser extends User with Timestamped {
  // ...
}
```

This is equivalent to creating an intermediate class that extends `User` and adds the members of `Timestamped`, which `RegisteredUser` then extends.

### 2.3. Constraining Mixins (`on` clause)

A mixin can restrict which classes it can be applied to using the `on` keyword. This allows the mixin to call methods on `super` or access properties that are guaranteed to exist on the base.

```zena
class Entity {
  id: i32;
  save(): void { ... }
}

mixin Syncable on Entity {
  sync(): void {
    this.save(); // OK because of 'on Entity'
    console.log(this.id);
  }
}
```

### 2.4. Composing Mixins

Mixins can be composed of other mixins.

```zena
mixin A { ... }
mixin B { ... }

mixin C with A, B {
  // ...
}
```

## 3. Semantics

### 3.1. Mixin Application

The expression `class C extends S with M1, M2 { ... }` creates a linearization:

`S` <- `S+M1` <- `S+M1+M2` <- `C`

- `S+M1` is a generated class that extends `S` and contains members of `M1`.
- `S+M1+M2` is a generated class that extends `S+M1` and contains members of `M2`.
- `C` extends `S+M1+M2`.

### 3.2. Constructors

Mixins cannot have constructors (`#new`). They are initialized as part of the object creation process.
(Open Question: Should mixins have initialization logic? Maybe a special method called by the generated constructor?)

### 3.3. Types

A mixin declaration defines a type (interface) that includes its members.
If `class C with M`, then `C` implements `M`.

## 4. Implementation (WASM-GC)

### 4.1. Struct Generation

For every application of a mixin `M` to a base `S`, the compiler generates a new WASM struct type.

Given:

```zena
class S { a: i32 }
mixin M { b: i32 }
class C extends S with M {}
```

WASM Types:

1. `$S`: `(struct (field $a i32))`
2. `$S_M`: `(sub $S (struct (field $a i32) (field $b i32)))`
3. `$C`: `(sub $S_M (struct (field $a i32) (field $b i32)))`

### 4.2. Method Dispatch

Methods defined in the mixin are emitted as functions.
Since the layout of the mixin's fields depends on the base class (the offset of `b` depends on the size of `S`), methods in the mixin cannot hardcode field indices if they access mixin state, UNLESS we use a strategy that handles this.

**Challenge**: In WASM GC, `struct.get` requires a fixed field index.
If `M` is applied to `S1` (size 1) and `S2` (size 2), the field `b` will be at index 1 and 2 respectively.
A single compiled function for `M.method()` cannot work for both unless:

1. We use an interface/vtable approach (dynamic dispatch).
2. We specialize (monomorphize) the mixin methods for each application.

**Decision**: **Monomorphization**.
Since Zena favors performance, we will duplicate the mixin methods for each application.
`M.method` applied to `S1` becomes `$S1_M_method`.
`M.method` applied to `S2` becomes `$S2_M_method`.

This allows direct field access (`struct.get`) and inlining.

### 4.3. `super` calls

If a mixin uses `super`, it refers to the `on` type (or `Object` if unspecified).
In the generated specialized method, `super` calls are resolved to the actual base class methods.

## 5. Example

```zena
mixin Position {
  x: i32 = 0;
  y: i32 = 0;
}

class Shape {}

class Circle extends Shape with Position {
  radius: i32;
}
```

Generates:

```wat
(type $Shape (struct))

;; Shape + Position
(type $Shape_Position (sub $Shape (struct
  (field (mut i32)) ; x
  (field (mut i32)) ; y
)))

;; Circle
(type $Circle (sub $Shape_Position (struct
  (field (mut i32)) ; x
  (field (mut i32)) ; y
  (field (mut i32)) ; radius
)))
```

## 6. Future Work: Constructors & Initialization

Currently, mixins cannot define constructors (`#new`). Initialization logic must be handled by the class applying the mixin.

### 6.1. Challenges

1.  **Parameter Passing**: If a mixin requires initialization arguments, how are they passed from the subclass constructor?
2.  **Super Calls**: If a mixin has a constructor, it likely needs to call `super()`. But the superclass is unknown until application time.

### 6.2. Potential Solutions

#### Pass-Through Constructors

Allow mixins to define a constructor that simply passes arguments through to `super`.

```zena
mixin M {
  #new(...args: any[]) {
    super(...args);
    // ... mixin init ...
  }
}
```

_Pros_: Simple for some cases.
_Cons_: `any[]` is not type-safe. Doesn't handle mixins that _add_ constructor parameters well.

#### Constrained Constructors

Use the `on` clause to enforce that the base class has a compatible constructor.

```zena
class Base {
  #new(id: i32) { ... }
}

mixin M on Base {
  // We know super accepts (i32)
  #new(id: i32, name: string) {
    super(id);
    this.name = name;
  }
}
```

#### Initialization Methods

Instead of constructors, mixins could define an `init` method that the subclass is responsible for calling.

### 6.3. Initialization Hazards

We must also consider "Initialization Hazards" where a base class constructor calls a virtual method that relies on fields in a subclass (or mixin) that haven't been initialized yet.
(See `docs/design/classes.md` for more details on this topic).
