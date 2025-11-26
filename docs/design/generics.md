# Generics Design

## Overview

Generics allow defining functions, classes, and interfaces that work over a
variety of types while maintaining type safety.

## Goals

1.  **Performance**: Zero-ovezenad abstractions. `List<i32>` should store raw
    `i32` values, not boxed objects.
2.  **Type Safety**: Compile-time checks for type correctness.
3.  **Simplicity**: Easy to understand syntax and semantics.

## Implementation Strategy: Monomorphization

There are several approaches to implementing generics. Understanding the
distinction between **Erasure**, **Reification**, and **Monomorphization** is
key to Zena's design.

### Terminology

1.  **Type Erasure (Java)**:
    - **Concept**: The compiler validates types, then removes ("erases") generic
      type information. At runtime, `List<String>` and `List<Integer>` are the
      same class (`List`), storing `Object`.
    - **Implication**: Primitives (like `int`) must be "boxed" into objects
      (`Integer`) to be stored. Casts are inserted automatically when retrieving
      values.
    - **Pros**: Shared code (smaller binary), backward compatibility.
    - **Cons**: Performance ovezenad (boxing/casting), no runtime type
      information for `T`.

2.  **Reification (C#)**:
    - **Concept**: Generic type information is preserved at runtime. `List<int>`
      and `List<string>` are distinct types.
    - **Implication**: You can check `instanceof T` or create `new T[]`.
    - **C# Implementation**:
      - **Value Types (`int`)**: Uses **Monomorphization**. The runtime
        generates specialized code for `List<int>`.
      - **Reference Types (`string`)**: Uses **Code Sharing**. `List<string>`
        and `List<object>` share the same machine code (since all references are
        pointers), but maintain distinct type metadata tables.

3.  **Monomorphization (C++, Rust, Zena)**:
    - **Concept**: The compiler generates a completely new copy of the function
      or class for _each_ concrete set of type arguments.
    - **Implication**: `Box<i32>` and `Box<f32>` are compiled as if the user
      manually wrote two different classes: `Box_i32` and `Box_f32`.
    - **Pros**: Maximum performance. Fields are typed precisely (e.g., `i32`
      field vs `(ref Object)`). No boxing, no casting.
    - **Cons**: "Code Bloat". Larger binary size because code is duplicated.

### Zena's Decision: Full Monomorphization

Given Zena's goal of targeting WASM-GC efficiently:

- **WASM Primitives**: `i32`, `f64`, etc., are not objects. They cannot be
  stored in a `(ref any)` field without allocation (boxing). To avoid this
  ovezenad, we **must** monomorphize value types.
- **Reference Types**: We have chosen to monomorphize reference types as well
  (e.g., `Box<Foo>` vs `Box<Bar>`).
  - _Why?_ In WASM-GC, fields are typed. A field of type `(ref Foo)` allows the
    engine to optimize access better than `(ref any)`. It also avoids the need
    for `ref.cast` instructions when reading fields, which improves runtime
    performance.
- **Result**: Zena generics are effectively **Reified** via Monomorphization.
  `Box<Foo>` is a distinct WASM struct type from `Box<Bar>`.

### Reference Types (Classes) Detail

For generic type arguments that are classes (reference types), we had two
choices:

1.  **Full Monomorphization (Selected)**: Generate a distinct struct for
    `Box<Foo>` and `Box<Bar>`.
    - _Pros_: Fields are strongly typed (`(ref Foo)` vs `(ref Bar)`). No runtime
      casts needed on access.
    - _Cons_: Increased binary size.
2.  **Code Sharing (Erasure)**: Generate a single `Box_Ref` where `T` is
    `anyref`.
    - _Pros_: Reduced binary size (like Java/C# for references).
    - _Cons_: Requires `ref.cast` (runtime check) when retrieving values.

**Decision**: Zena currently uses **Full Monomorphization** for all types,
including classes. This aligns with our performance goal by avoiding runtime
casts. Future optimizations could implement code sharing for references if
binary size becomes a concern.

## Syntax (TypeScript-like)

### Generic Classes

```typescript
class Box<T> {
  value: T;
  #new(v: T) {
    this.value = v;
  }
}

let b = new Box<i32>(10);
```

### Generic Functions

```typescript
const identity = <T>(arg: T): T => arg;

let x = identity<i32>(10);
```

## Variance

Variance describes how subtyping between complex types relates to subtyping
between their components.

- **Covariance (`out T`)**: If `Cat` extends `Animal`, then `Producer<Cat>` is a
  `Producer<Animal>`. Safe for _reading_.
- **Contravariance (`in T`)**: If `Cat` extends `Animal`, then
  `Consumer<Animal>` is a `Consumer<Cat>`. Safe for _writing_.
- **Invariance**: No subtyping relationship. `List<Cat>` is not `List<Animal>`.
  Required for mutable data structures (read & write).

### C# Approach

C# allows explicit variance annotations on **interfaces** and **delegates**
(e.g., `interface IEnumerable<out T>`). Classes are always invariant.

### Zena Approach

To start, Zena should enforce **Invariance** for all generic classes.

- `Box<String>` is NOT a subtype of `Box<Object>`.
- This is simple, safe, and sufficient for `Map` and `Array`.
- We can explore variance later if we add Interfaces.

## Compilation Process (Monomorphization)

1.  **Parsing**: Parse generic parameters `<T>` in AST.
2.  **Type Checking**:
    - When `new Box<i32>` is encountered, register a "request" for
      specialization `Box_i32`.
    - Check the body of `Box` substituting `T` with `i32`.
3.  **Codegen**:
    - Instead of generating code for `Box` directly, generate code for each
      requested specialization (`Box_i32`, `Box_string`, etc.).
    - Mangle names: `Box<i32>` -> `Box_i32`.

## Constraints

We may need to constrain generic types (e.g., `T extends SomeClass`).

- _Initial Scope_: Unconstrained generics.

## Impact on Standard Library

With generics, we can implement `Map` properly:

```typescript
class Map<K, V> {
  buckets: Array<Entry<K, V>>;
  // ...
}
```

The compiler will generate `Map_i32_string` when the user writes `new Map<i32,
string>()`.

## Future Considerations: Tunability & Hybrid Approaches

The tension between **Runtime Performance** (Monomorphization) and **Binary
Size** (Erasure/Code Sharing) is significant, especially for WASM where download
size matters.

### Precedence in Other Languages

1.  **Swift**: Uses a sophisticated hybrid model. It can specialize generics
    (monomorphize) when the type is known at compile time for maximum speed.
    However, it can also compile a single version of a function that uses
    "Witness Tables" (runtime dictionaries of function pointers) to handle any
    type. This allows Swift to avoid code bloat while still offering high
    performance where it counts.
2.  **Rust**: Defaults heavily to monomorphization (static dispatch). However,
    developers can opt-in to erasure/dynamic dispatch using `dyn Trait`. This
    gives the developer explicit control: `Box<T>` (monomorphized) vs `Box<dyn
Trait>` (erased/shared).
3.  **C#**: As mentioned, automatically switches strategies based on the type
    argument (Monomorphization for `int`, Code Sharing for `string`).

### Potential Options for Zena

To balance these priorities, Zena could adopt one of the following strategies in
the future:

1.  **Compiler Optimization Levels**:
    - `-Ospeed` (Default): Full monomorphization.
    - `-Osize`: Force code sharing for all reference types (erasure to
      `anyref`). Value types (`i32`) would likely still need monomorphization or
      boxing.
2.  **Heuristic Auto-Tuning**: The compiler could detect if a generic class is
    instantiated with many different reference types and choose to generate a
    shared version to save space, while specializing for heavily used hot-paths.
3.  **Explicit Syntax**: Allow the user to request erasure.
    - `class Box<shared T> { ... }`
    - Or at instantiation: `new Box<dyn Foo>()`.

For now, we prioritize **Performance** via full monomorphization, but we
acknowledge that **Binary Size** is a critical constraint that may force us to
adopt a hybrid model later.
