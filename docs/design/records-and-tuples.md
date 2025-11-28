# Records and Tuples Design

**Status: Proposed**

This document outlines the design for immutable Records and Tuples in Zena.

## 1. Overview

Records and Tuples are **shallowly immutable**, structural data types. They are designed to support:

- **Named Arguments**: Passing named values to functions (which may be mutable objects).
- **Multiple Return Values**: Returning multiple values from functions.
- **Data Grouping**: Simple grouping of related data without the ceremony of Classes.

**Terminology Note**:
In Zena, "Record" and "Tuple" refer to **shallowly immutable containers**. This aligns with **Dart** and **Swift**.
- They have **Structural Equality** (two tuples are equal if their fields are equal).
- They can hold **Mutable References** (e.g., a Tuple containing a mutable Array).
- This differs from the **TC39 (JavaScript)** proposal, where Records/Tuples are *deeply* immutable.

## 2. Syntax

### 2.1 Records

Records are collections of named fields.

**Type Syntax**:

```typescript
type Point = {x: i32; y: i32};
```

**Literal Syntax**:

```typescript
const p = {x: 10, y: 20};
```

**Access Syntax**:

```typescript
const x = p.x;
```

### 2.2 Tuples

Tuples are fixed-length collections of ordered fields.

**Type Syntax**:

```typescript
type Pair = [i32, string];
```

**Literal Syntax**:

```typescript
const p = [10, 'hello'];
```

**Access Syntax**:

```typescript
const id = p[0];
const name = p[1];
```

## 3. Semantics

- **Immutability**: Fields of records and tuples are **shallowly immutable**. You cannot reassign a field (`r.x = 1` is error), but if a field holds a mutable object (like an Array), you can mutate that object (`r.list.push(1)` is ok).
- **Structural Typing**: Records and Tuples are structurally typed. `{ x: i32 }` is the same type regardless of where it is defined.
- **Value Semantics**: Equality (`==`) compares contents (structural equality), not reference identity.
  - `[1, 2] == [1, 2]` is `true`.
  - `[a] == [a]` is `true` (where `a` is an object reference).
  - `[new Obj()] == [new Obj()]` is `false` (because the object references are different).

## 4. Implementation Strategy

To achieve high performance and avoid unnecessary allocations, we will employ **Allocation Sinking** and **Argument Explosion**.

### 4.1 Canonicalized Structs (The "Boxed" Representation)

For cases where records/tuples must be stored on the heap (e.g., in an Array, or as a field of a Class), they will be represented by **WASM GC Structs**.

The compiler will maintain a registry of used record shapes.

- `{ x: i32, y: i32 }` -> `(type $Record_i32_i32 (struct (field $x i32) (field $y i32)))`

### 4.2 Allocation Sinking (The "Unboxed" Optimization)

The user explicitly requested that we avoid allocations for common patterns like named arguments and multiple return values.

#### 4.2.1 Function Parameters (Named Arguments)

When a function accepts a Record as an argument, the compiler can "explode" the record into individual parameters in the WASM function signature.

**Source**:

```typescript
const draw = (opts: { x: i32, y: i32, color: string }) => { ... }

draw({ x: 10, y: 20, color: "red" });
```

**WASM Signature**:
Instead of taking a single `(ref $Record_...)`, the function `draw` will take:
`(func $draw (param $x i32) (param $y i32) (param $color (ref string)) ...)`

**Call Site**:
The call site passes the values directly. No struct is allocated.

**Benefits**:

- **Zero Allocation**: The record literal `{...}` effectively disappears.
- **Width Subtyping**: If I pass `{ x: 10, y: 20, color: "red", z: 99 }` to `draw`, the compiler simply ignores `z` and passes the required fields. This solves the "Nominal vs Structural" subtyping issue for arguments!

#### 4.2.2 Return Values (Multiple Returns)

When a function returns a Record or Tuple, the compiler can use WASM's **Multi-Value Return** feature.

**Source**:

```typescript
const getPos = () => {
  return {x: 10, y: 20};
};

const {x, y} = getPos();
```

**WASM Signature**:
`(func $getPos (result i32) (result i32))`

**Call Site**:
The caller receives two values on the stack.

- If the caller immediately destructs: `const { x, y } = ...`, the values are bound to locals. No allocation.
- If the caller assigns to a variable: `const p = getPos()`, the compiler _must_ allocate the struct at that point (box the result) to store it in a single local `p`.

### 4.3 Destructuring

Destructuring is a compile-time transformation that extracts values.

**Record Destructuring**:

```typescript
const {a, b} = record;
```

**Tuple Destructuring**:

```typescript
const [x, y] = tuple;
```

If the source is an "exploded" return value, destructuring is a no-op (just binding locals).
If the source is a "boxed" struct, destructuring emits `struct.get` instructions.

## 5. Type System Details

### 5.1 Structural Compatibility

Since we use "Explosion" for arguments, we can support **Width Subtyping** for function calls.

`Type A` is assignable to `Type B` if `A` has all the fields of `B` with compatible types.

- **Boxed Context**: If we are assigning a Record to a variable typed as a Record (e.g. `let r: {x: i32} = {x: 1, y: 2}`), we might need to allocate the _exact_ struct expected by the variable, or allocate the larger one.
  - _Decision_: For v1, variables might require exact shape matches to avoid complex casting/copying.
  - _Refinement_: If `r` is just a local, we can infer the larger type.
  - _Constraint_: Arrays `Array<{x: i32}>`. If we put `{x: 1, y: 2}` into it, we probably need to copy/truncate to the exact struct type, OR we don't support width subtyping in Arrays (invariant).

### 5.2 Type Syntax

We will adopt TypeScript's syntax.

```typescript
// Record Type
type User = {
  id: i32;
  name: string;
};

// Tuple Type
type Vec3 = [f32, f32, f32];
```

## 6. Host Interop

When a function using "Exploded" arguments or returns is exported to the host (JavaScript):

- **Arguments**: The exported function must accept a JavaScript Object. A wrapper function (thunk) will be generated to destructure the JS object and call the internal "exploded" WASM function.
- **Return Values**: The exported function must return a JavaScript Object (or Array for tuples). A wrapper function will collect the multiple WASM return values and construct the JS object/array.

This ensures that the internal optimization does not break external compatibility.

## 7. Open Questions

1.  **Recursive Types**: Can records be recursive? `{ next: Self }`? (Probably yes, via `type` alias).
2.  **Methods**: Do records have methods? (No, they are data. Use functions).
3.  **Spread**: `const p2 = { ...p1, z: 3 };` (Essential for immutable updates).

## 8. Comparison with Interfaces & Classes

### 8.1 Records vs Interfaces

| Feature       | Record (`{ x: i32 }`)                            | Interface (`interface I { x: i32 }`)      |
| :------------ | :----------------------------------------------- | :---------------------------------------- |
| **Typing**    | **Structural**. Any shape with `x: i32` matches. | **Nominal**. Must explicitly `implement`. |
| **Semantics** | **Value** (Data). Immutable.                     | **Reference** (Behavior). Polymorphic.    |
| **Methods**   | No.                                              | Yes.                                      |
| **Runtime**   | Optimized away (exploded) or specific Struct.    | Fat Pointer (Instance + VTable).          |

**Key Distinction**: Use Records for _data transfer_ (DTOs, options objects, multiple returns). Use Interfaces for _contracts_ and _abstraction_.

### 8.2 Can a Class satisfy a Record?

**Yes, in specific contexts.**

Because Record types support **Width Subtyping** via argument explosion, a Class instance can be passed to a function expecting a Record, provided it has the required fields.

```typescript
class Vector {
  x: i32 = 0;
  y: i32 = 0;
}

const printPoint = (p: { x: i32, y: i32 }) => { ... }

const v = new Vector();
// ✅ Valid: Compiler explodes 'v' into 'v.x' and 'v.y' to pass to 'printPoint'.
printPoint(v);
```

However, a Class instance **cannot** be assigned to a variable of a Boxed Record type (e.g., `Array<{x: i32}>`) because the memory layouts (WASM Structs) are different.

### 8.3 Can a Record satisfy an Interface?

**No.**

Interfaces in Zena are **Nominal**. A type must explicitly declare that it implements an interface. Since Records are often anonymous and structural, they cannot declare implementation.

```typescript
interface IPoint {
  get x(): i32;
}

const r = {x: 10};
// ❌ Error: Record does not explicitly implement IPoint.
const i: IPoint = r;
```

### 8.4 Nominal vs. Structural Philosophy

Zena adopts a **Hybrid** approach:

- **Nominal (Classes/Interfaces)**: Used for defining application architecture, domain models, and behavior. Ensures safety and clear intent.
- **Structural (Records/Tuples)**: Used for transient data, function arguments, and return values. Ensures convenience and flexibility.

This precedence exists in languages like **Dart** and **Swift**, which are strongly typed and nominal but support structural Records/Tuples for lightweight data manipulation.

## 9. Implementation Plan

### Phase 1: Parser & AST
- [x] **AST Nodes**: Add `RecordLiteral`, `TupleLiteral`, `RecordType`, `TupleType`, `PropertyAccess` (update), `ElementAccess` (update).
- [x] **Parser**:
  - Parse `{ x: 1, y: 2 }` as `RecordLiteral`.
  - Parse `[ 1, 2 ]` as `TupleLiteral`.
  - Parse `{ x: i32 }` as `RecordType`.
  - Parse `[i32, i32]` as `TupleType`.
  - Update `.` access to handle records.
  - Update `[]` access to handle tuples (constant indices only for now?).

### Phase 2: Type Checker
- [x] **Type Representation**: Add `RecordType` and `TupleType` to the type system.
- [x] **Inference**: Infer types from literals.
- [x] **Structural Compatibility**: Implement `isAssignable` logic for structural types.
- [x] **Member Access**: Check valid field access on records and index access on tuples.

### Phase 3: Code Generator (Boxed)

- [ ] **Struct Registry**: Mechanism to generate/reuse WASM GC struct definitions for record shapes.
- [ ] **Allocation**: Emit `struct.new` for literals.
- [ ] **Access**: Emit `struct.get` for property/element access.

### Phase 4: Code Generator (Unboxed Optimization)

- [ ] **Argument Explosion**:
  - Detect functions accepting records.
  - Rewrite function signature to flatten parameters.
  - Rewrite call sites to pass individual fields.
- [ ] **Multi-Value Return**:
  - Detect functions returning records/tuples.
  - Rewrite function signature to return multiple values.
  - Rewrite return statements.
  - Rewrite call sites to bind multiple results.

### Phase 5: Host Interop

- [ ] **Thunks**: Generate JS wrapper functions for exported functions using records/tuples.
