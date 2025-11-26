# Type System Design

This document outlines the core design decisions for the Rhea type system.

## 1. Nominal Typing

Rhea uses a **Nominal Type System**. Types are compatible if and only if they
are explicitly declared to be compatible (e.g., via inheritance or interface
implementation), not just because they share the same structure.

### Decision

Classes and Interfaces must be explicitly related. A class `A` is a subtype of
interface `I` only if `class A implements I` is declared.

```typescript
interface Runnable {
  run(): void;
}

// ✅ Valid
class Task implements Runnable {
  run(): void {}
}

// ❌ Invalid (even though it has the run method)
class Car {
  run(): void {}
}
```

### Rationale

- **WASM-GC Alignment**: WASM's GC type system is nominal. `struct A` and
  `struct B` are distinct types even if they have identical fields. Mapping a
  structural system (like TypeScript) to WASM requires complex boxing or runtime
  overhead.
- **Safety**: Prevents accidental compatibility between semantically different
  but structurally identical types (e.g., `User` vs `Product`).
- **Performance**: Type checks (`ref.test`) are O(1) and map directly to WASM
  instructions.

### Pros

- Zero-cost abstraction over WASM types.
- Fast `instanceof` checks.
- Clearer intent in code.

### Cons

- More verbose than structural typing (must write `implements`).
- Less flexible for ad-hoc polymorphism.

## 2. Split Namespace (Types vs Values)

Rhea uses a **Split Namespace** model, similar to TypeScript.

### Decision

- **Types**: Exist primarily at compile-time (e.g., `interface`, `type`
  aliases). They cannot be passed as values.
- **Values**: Runtime entities (e.g., variables, function instances).
- **Classes**: Inhabit _both_ namespaces.
  - As a Type: Represents the instance shape.
  - As a Value: Represents the constructor and static members.

### Rationale

- **Simplicity**: Matches the mental model of TypeScript developers.
- **Performance**: Avoids the overhead of Reified Generics or runtime type
  information (RTTI) for every type.

## 3. Interfaces

Interfaces are **Compile-Time Only** contracts.

### Decision

- Interfaces define a set of methods/fields that a class must implement.
- They do **not** exist at runtime.
- `instanceof MyInterface` is **not supported** (initially).

### Rationale

- **WASM Limitations**: WASM-GC does not yet have native support for interfaces
  (protocol/trait types). Implementing runtime interfaces requires "fat
  pointers" or complex vtable lookups, which impacts performance and binary
  size.
- **MVP Scope**: Compile-time checks cover 90% of use cases.

### Pros

- No runtime overhead.
- Simplifies compiler implementation.

### Cons

- Cannot check if an arbitrary object implements an interface at runtime.
