# Type System Design

This document outlines the core design decisions for the Zena type system.

## 1. Nominal Typing

**Status: Implemented (Classes)**

Zena uses a **Nominal Type System**. Types are compatible if and only if they
are explicitly declared to be compatible (e.g., via inheritance or interface
implementation), not just because they share the same structure.

See [Classes Design](./classes.md) for more details.

### Decision

Classes and Interfaces must be explicitly related. A class `A` is a subtype of
interface `I` only if `class A implements I` is declared.

```zena
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
  ovezenad.
- **Safety**: Prevents accidental compatibility between semantically different
  but structurally identical types (e.g., `User` vs `Product`).
- **Performance**: Type checks (`ref.test`) are O(1) and map directly to WASM
  instructions.

### Pros

- Zero-cost abstraction over WASM types.
- Fast `is` checks.
- Clearer intent in code.

### Cons

- More verbose than structural typing (must write `implements`).
- Less flexible for ad-hoc polymorphism.

## 2. Split Namespace (Types vs Values)

**Status: Implemented**

Zena uses a **Split Namespace** model, similar to TypeScript.

### Decision

- **Types**: Exist primarily at compile-time (e.g., `interface`, `type`
  aliases). They cannot be passed as values.
- **Values**: Runtime entities (e.g., variables, function instances).
- **Classes**: Inhabit _both_ namespaces.
  - As a Type: Represents the instance shape.
  - As a Value: Represents the constructor and static members.

### Rationale

- **Simplicity**: Matches the mental model of TypeScript developers.
- **Performance**: Avoids the ovezenad of Reified Generics or runtime type
  information (RTTI) for every type.

## 3. Interfaces

**Status: Implemented**

Interfaces are contracts that define a set of methods/fields. In Zena, they exist at runtime using a **Fat Pointer** representation.

See [Interfaces Design](./interfaces.md) for implementation details.

### Decision

- Interfaces define a set of methods/fields that a class must implement.
- **Runtime Representation**: An interface value is a struct containing the instance reference and a VTable (Fat Pointer).
- **Performance**: Dispatch is O(1) but requires an allocation when casting an object to an interface (boxing).

### Rationale

- **WASM Limitations**: WASM-GC does not natively support traits. Fat pointers provide a robust way to support polymorphism across disjoint hierarchies.

### Pros

- Supports true polymorphism.
- O(1) dispatch.

### Cons

- Requires allocation (boxing) when converting a class instance to an interface.

## 4. Primitive Types

**Status: Implemented**

- `i32`, `f32`, `boolean`, `String`: **Implemented**
- `i64`, `f64`: **Implemented**

Zena maps its primitive types directly to WebAssembly value types to ensure maximum performance and zero ovezenad.

See [Strings Design](./strings.md) for details on string implementation.

### Numeric Types

- **`i32`**: 32-bit signed integer. Default for integer literals.
- **`i64`**: 64-bit signed integer. Essential for large numbers and memory addressing.
- **`f32`**: 32-bit floating point.
- **`f64`**: 64-bit floating point. Default for float literals (to match JS precision).

### Other Primitives

- **`boolean`**: Maps to `i32` (0 or 1).
- **`void`**: Represents the absence of a value (for function returns).
- **`ByteArray`**: Maps to `(array (mut i8))`. Used for low-level binary data and string implementation.

### Future Consideration: SIMD

- **`v128`**: 128-bit vector type for SIMD operations.

## 5. Nullability

**Status: Implemented**

Zena is **Non-Nullable by Default**.

### Decision

- All types `T` are non-nullable. A variable of type `String` cannot hold `null`.
- Nullability is opt-in via Union Types: `String | null`.

### Rationale

- **Safety**: Eliminates "Null Reference Exceptions" for the vast majority of code.
- **WASM Mapping**:
  - `T` maps to `(ref $T)` (Non-nullable reference).
  - `T | null` maps to `(ref null $T)` (Nullable reference).
- **Optimization**: Non-nullable references allow the WASM engine to elide null checks.

## 6. Algebraic Data Types

**Status: Partially Implemented**

### Union Types (`A | B`)

**Status: Implemented with Constraints**

Zena supports union types, but with specific constraints regarding primitive types to ensure soundness and performance.

#### Constraints

- **Reference-Only Unions**: Unions of reference types are always allowed.
  - ✅ `String | null`
  - ✅ `Point | Shape`
  - ✅ `Box<i32> | null`
  - ✅ `array<i32> | null`

- **Same-Base Primitive Unions**: Primitives may union with other primitives **of the same base type**.
  - ✅ `true | false` (both are `boolean`)
  - ✅ `1 | 2 | 3` (all are `i32`, when numeric literal types are implemented)

- **No Mixing Primitives with References**: Value primitives cannot union with reference types.
  - ❌ `i32 | null`
  - ❌ `boolean | String`
  - ❌ `true | null`

- **No Mixing Different Primitive Base Types**: Primitives of different base types cannot be unioned.
  - ❌ `i32 | f32`
  - ❌ `1 | 1.0` (when numeric literal types are implemented)

#### Rationale

1.  **WASM Representation**:
    - **Value Types** (`i32`, `f32`) live on the stack or in locals. They are not GC-managed references.
    - **Reference Types** (`ref $T`, `ref null $T`) live on the heap.
    - A union like `i32 | String` would require a storage location that can hold either 4 bytes of raw integer data OR a GC reference. WASM has no such type.
    - To avoid implicit allocation and performance cliffs, Zena requires explicit boxing for primitives in unions with references.

2.  **Runtime Disambiguation**:
    - To safely use a value from a union `A | B`, the runtime must be able to determine if the value is `A` or `B`.
    - Reference types (Classes, Arrays) carry runtime type information (RTTI) or can be checked via `ref.test`.
    - Value types (`i32`) are just raw bits and carry no type information. Distinguishing `i32` from `f32` in a union is impossible without a tag (boxing).
    - Primitives of the same base type (like `true | false`) don't need runtime discrimination—they're all represented the same way.

#### "Primitives" vs Reference Types

It is important to distinguish between **Value Primitives** and **Reference Types**:

- **Value Primitives** (Cannot mix with references in unions): `i32`, `i64`, `f32`, `f64`, `boolean`, `true`, `false`.
- **Reference Types** (Can freely union with each other): `String`, `ByteArray`, `array<T>`, classes, interfaces.

#### Solution: `Box<T>`

To store a primitive in a union with references (e.g. a nullable integer), use the standard library `Box<T>` class.

```zena
let x: Box<i32> | null = new Box(10);
```

#### Unbounded Type Parameters in Unions

**Status: Enforced at declaration**

Unions containing unbounded type parameters mixed with reference types (including `null`) are **not allowed**. This prevents APIs from being defined that cannot work with primitive type arguments.

```zena
// ❌ Error: Unbounded type parameter 'T' cannot appear in union with reference types
class Container<T> {
  value: T | null;
}

// ❌ Error: Same issue - will fail if T is instantiated with a primitive
type Nullable<T> = T | null;

// ✅ OK: T is constrained to reference types via anyref
class Container<T extends anyref> {
  value: T | null;
}

// ✅ OK: Use multi-return instead (zero allocation, works with all types)
class Container<T> {
  get(): (T, boolean);
}

// ✅ OK: Use Option<T> (Some<T> is always a reference type)
class Container<T> {
  find(): Option<T>;
}
```

##### Rationale

The problem with `T | null` where `T` is unbounded:

1.  **Instantiation trap**: `Container<string>` works fine, but `Container<i32>` creates `i32 | null`, which violates the primitive-in-union rule.
2.  **Late error**: Without this rule, the error would only appear when the generic is instantiated with a primitive — possibly far from where the problematic API was defined.
3.  **API design smell**: `T | null` conflates "missing" with "null-valued", which is problematic even for reference types.

##### Recommended Patterns

Instead of `T | null` for "maybe has a value" semantics, use:

| Pattern                | Allocation | Use Case                              |
| ---------------------- | ---------- | ------------------------------------- |
| `get(): (T, boolean)`  | None       | Immediate check-and-use (most common) |
| `getOr(default: T): T` | None       | When a sensible default exists        |
| `find(): Option<T>`    | `Some<T>`  | When you need to store/pass the maybe |
| `has()` + `[]`         | None       | Check then access (throws if missing) |

Multi-return `(T, boolean)` is the **preferred pattern** for "maybe" results because:

- Zero allocation — values stay on the WASM stack
- Works with all types including primitives
- Unambiguous — distinguishes "not found" from "found with null value"

When not found, return `(_, false)` where `_` is the hole literal with type `never`.
The caller must not access the first element when the second is `false`.

Example from `Map<K, V>`:

````zena
class Map<K, V> {
  // Throws KeyNotFoundError if missing
  operator [](key: K): V

  // Multi-return, zero allocation — the workhorse
  // Returns (_, false) when not found; first element must not be accessed
  get(key: K): (V, boolean)

  // Returns default if not found
  getOr(key: K, default: V): V

  // Returns Option — when you need to store the result
  find(key: K): Option<V>

  // Check existence
  has(key: K): boolean
}

- **Implementation**:
  - If `A` and `B` share a common ancestor class `Base`, `A | B` is treated as `Base`.
  - If they are unrelated, they are treated as `any` (WASM `anyref` or `eqref`).
- **Function Calls**:
  - Calling a union of function types (e.g., `((a: i32) => void) | ((a: i32, b: i32) => void)`) is supported.
  - The compiler generates a runtime dispatch sequence that checks the actual type of the function and calls it with the appropriate arguments (adapting/dropping extra arguments if necessary).
- **Discrimination**:
  - Zena encourages **Type-Based Discrimination** (using classes) over **Tag-Based Discrimination** (string literals).
  - **Pattern Matching**:

    ```zena
    type Shape = Circle | Square;

    let area = (s: Shape) => {
      if (s is Circle) return s.radius * s.radius * 3.14;
      if (s is Square) return s.side * s.side;
    }
    ```

  - **WASM Optimization**: `is` checks compile directly to `br_on_cast` or `ref.test` instructions, which are extremely fast.

### Intersection Types (`A & B`)

- **Usage**: Primarily for combining Interfaces.
  - `let process = (item: Runnable & Disposable) => { ... }`
- **Implementation**: The value is treated as a reference that satisfies both contracts.

## 7. Type Aliases (`type`)

**Status: Planned**

The `type` keyword is used to create aliases for types, not to define new shapes.

### Decision

- **`interface`**: Defines a **Shape** (contract).
- **`class`**: Defines an **Implementation** + **Shape**.
- **`type`**: Defines an **Alias** or **Composition**.

### Examples

```zena
// ✅ Valid: Union Alias
type MaybeString = String | null;

// ✅ Valid: Function Signature
type Handler = (event: String) => void;

// ❌ Invalid: Object Literal Shape (Use Interface instead)
// type Point = { x: i32, y: i32 };
````

### Rationale

- **Clarity**: Separates "naming a thing" (type) from "defining the structure of a thing" (interface/class).
- **Simplicity**: Avoids the TypeScript confusion of "Should I use type or interface?". In Zena: if it has fields/methods, it's an interface. If it's a combination of other types, it's a type alias.

## 8. Soundness & Casting

**Status: Policy**

Zena is designed to be a **Sound** language.

### Decision

- **Checked Casts**: All explicit type casts (e.g., `x as T`) are runtime-checked.
- **No Unsafe Casts**: There is no mechanism to force a cast without a check (except potentially via FFI/Unsafe blocks in the future, which would be explicitly marked).

### Rationale

- **WASM Safety**: WASM-GC enforces type safety at the instruction level. An unchecked cast would require bypassing the WASM type system, which is generally not possible or desirable in safe code.
- **Reliability**: Guarantees that if a variable has type `T`, it really is a `T`.
