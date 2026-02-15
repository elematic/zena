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
- This differs from the **TC39 (JavaScript)** proposal, where Records/Tuples are _deeply_ immutable.

## 2. Syntax

### 2.1 Records

Records are collections of named fields.

**Type Syntax**:

```zena
type Point = {x: i32; y: i32};
```

**Literal Syntax**:

```zena
let p = {x: 10, y: 20};
```

**Access Syntax**:

```zena
let x = p.x;
```

### 2.2 Tuples

Tuples are fixed-length collections of ordered fields.

**Type Syntax**:

```zena
type Pair = [i32, string];
```

**Literal Syntax**:

```zena
let p = [10, 'hello'];
```

**Access Syntax**:

```zena
let id = p[0];
let name = p[1];
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

```zena
let draw = (opts: { x: i32, y: i32, color: string }) => { ... }

draw({ x: 10, y: 20, color: "red" });
```

**WASM Signature**:
Instead of taking a single `(ref $Record_...)`, the function `draw` will take:
`(func $draw (param $x i32) (param $y i32) (param $color (ref string)) ...)`

**Call Site**:
The call site passes the values directly. No struct is allocated.

**Benefits**:

- **Zero Allocation**: The record literal `{...}` effectively disappears.

> **Note**: Width subtyping (passing extra fields) is NOT supported. See Section 5.1.

#### 4.2.2 Return Values (Multiple Returns)

When a function returns a Record or Tuple, the compiler can use WASM's **Multi-Value Return** feature.

**Source**:

```zena
let getPos = () => {
  return {x: 10, y: 20};
};

let {x, y} = getPos();
```

**WASM Signature**:
`(func $getPos (result i32) (result i32))`

**Call Site**:
The caller receives two values on the stack.

- If the caller immediately destructs: `let { x, y } = ...`, the values are bound to locals. No allocation.
- If the caller assigns to a variable: `let p = getPos()`, the compiler _must_ allocate the struct at that point (box the result) to store it in a single local `p`.

### 4.3 Destructuring

Destructuring is a compile-time transformation that extracts values.

**Record Destructuring**:

```zena
let {a, b} = record;
```

**Tuple Destructuring**:

```zena
let [x, y] = tuple;
```

If the source is an "exploded" return value, destructuring is a no-op (just binding locals).
If the source is a "boxed" struct, destructuring emits `struct.get` instructions.

## 5. Type System Details

### 5.1 Records as Interfaces (Width Subtyping)

**Decision**: Records behave like interfaces. A record type `{x: i32, y: i32}` accepts any value that has _at least_ those fields.

```zena
let point3d = {x: 1, y: 2, z: 3};
let point2d: {x: i32, y: i32} = point3d;  // ✅ OK - z is ignored
```

**Rationale**:

1. **Familiar to JS/TS developers**: This matches TypeScript's structural typing for objects, reducing surprise.

2. **Option bags work naturally**: Functions can accept records with more fields than they need.

3. **Consistent with interfaces**: Records and interfaces have the same subtyping rules, reducing cognitive load.

**Implementation**: Record field access uses dynamic dispatch (like interfaces). The compiler aggressively optimizes this away when types are statically known. See Section 5.4.

### 5.2 Optional Fields

Optional fields allow callers to omit fields entirely. This is the "option bag" pattern.

```zena
type RequestOpts = {
  url: string,
  timeout?: i32,   // Optional - caller can omit
  retries?: i32,
};

let request = (opts: RequestOpts) => {
  let {url, timeout = 30000, retries = 3} = opts;  // Defaults at destructuring
  // ...
};

request({url: "/api"});                    // ✅ Optional fields omitted
request({url: "/api", timeout: 5000});     // ✅ Partial
request({url: "/api", timeout: 5000, retries: 1});  // ✅ All provided
```

**Key distinction**: Optional (`?`) does NOT mean `| null`. It means the field may or may not be present on the underlying value. This is different from a nullable field:

```zena
{foo?: i32}    // Field may be absent - no boxing
{foo: i32?}    // Field is always present, value may be null - boxing
```

**Accessing optional fields**:

Optional fields require narrowing before direct access:

```zena
let process = (opts: {timeout?: i32}) => {
  opts.timeout;           // ❌ Error - might not exist
  opts.timeout ?? 0;      // ✅ Provide default
  if ("timeout" in opts) {
    opts.timeout;         // ✅ Narrowed - safe to access
  }
};
```

### 5.3 Exact Record Types

For performance-critical code where you need guaranteed direct field access (no dispatch), use **exact record types**:

```zena
// Syntax TBD - options include:
exact {x: i32, y: i32}
{x: i32, y: i32}!
#[exact] type Point = {x: i32, y: i32};
```

Exact records:

- Do NOT support width subtyping
- Do NOT support optional fields
- Use direct `struct.get` - no dispatch overhead
- Are suitable for hot loops and data-intensive code

```zena
let p: exact {x: i32, y: i32} = {x: 1, y: 2};      // ✅
let q: exact {x: i32, y: i32} = {x: 1, y: 2, z: 3}; // ❌ Extra field rejected
```

| Aspect          | Record (default)     | Exact Record    |
| --------------- | -------------------- | --------------- |
| Width subtyping | ✅ Yes               | ❌ No           |
| Optional fields | ✅ Yes               | ❌ No           |
| Field access    | Dispatch (optimized) | Direct          |
| Use case        | APIs, options        | Hot loops, data |

### 5.4 Dispatch Optimization

Although records use dynamic dispatch for field access, the compiler eliminates this overhead in common cases:

**Static elimination (compile-time):**

1. **Literal at call site** - most common case:

   ```zena
   process({timeout: 30});  // Compiler knows exact shape → direct access
   ```

2. **Type matches exactly** - no width difference:

   ```zena
   let opts: {timeout: i32} = {timeout: 30};
   process(opts);  // If param is also {timeout: i32} → direct access
   ```

3. **Inlining reveals concrete type:**

   ```zena
   let makeOpts = () => {timeout: 30};
   process(makeOpts());  // After inlining, shape is known → direct access
   ```

4. **Flow analysis within function:**
   ```zena
   let process = (opts: {timeout?: i32}) => {
     let t = opts.timeout ?? 30;  // Dispatch here, once
     // From here, t is concrete i32 - no dispatch
   };
   ```

**The common pattern**: Most option-bag code destructures immediately:

```zena
let process = (opts: {timeout?: i32, retries?: i32}) => {
  let {timeout = 30, retries = 3} = opts;  // Dispatch cost paid once
  // From here, all concrete values - no dispatch
};
```

**Remaining dynamic cases** (appropriate cost):

- Storing in collections of heterogeneous records
- Passing through multiple function boundaries without destructuring
- Truly polymorphic code

For code that cannot tolerate any dispatch overhead, use **exact record types**.

### 5.2 Type Syntax

We will adopt TypeScript's syntax.

```zena
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
3.  **Spread**: `let p2 = { ...p1, z: 3 };` (Essential for immutable updates).
4.  ~~**Optional Fields**~~: Resolved. See Section 5.2. Optional fields use `?` syntax and require narrowing before access.
5.  **Exact Type Syntax**: What syntax for exact record types? Options: `exact {...}`, `{...}!`, `#[exact]`.
6.  **`in` Operator**: Implement `"field" in record` for narrowing optional fields.
7.  **Pattern Matching Integration**: How do optional fields work with pattern matching?

## 8. Comparison with Interfaces & Classes

### 8.1 Records vs Interfaces

| Feature       | Record (`{ x: i32 }`)                            | Interface (`interface I { x: i32 }`)       |
| :------------ | :----------------------------------------------- | :----------------------------------------- |
| **Typing**    | **Structural**. Any shape with `x: i32` matches. | **Nominal**. Must explicitly `implement`.  |
| **Subtyping** | **Width subtyping**. Extra fields allowed.       | **Nominal subtyping**. Explicit hierarchy. |
| **Semantics** | **Value** (Data). Immutable.                     | **Reference** (Behavior). Polymorphic.     |
| **Methods**   | No.                                              | Yes.                                       |
| **Runtime**   | Dispatch (optimized) or exact struct.            | Fat Pointer (Instance + VTable).           |

**Key Insight**: Records behave _like_ interfaces in terms of subtyping (width subtyping allowed), but are used for _data transfer_ rather than _contracts_. This provides TypeScript-like ergonomics while maintaining a clear conceptual distinction.

### 8.2 Can a Class satisfy a Record type?

**Yes, via structural compatibility.**

Since records use width subtyping, a Class instance CAN be passed where a Record type is expected, as long as it has the required fields:

```zena
class Vector {
  x: i32 = 0;
  y: i32 = 0;

  magnitude(): f64 { ... }
}

let printPoint = (p: {x: i32, y: i32}) => { ... }

let v = new Vector();
printPoint(v);  // ✅ Vector has x and y fields - compatible
```

This works through dispatch - the record type accesses fields through the same mechanism as interfaces.

**Note**: For exact record types, this would NOT work:

```zena
let printExact = (p: exact {x: i32, y: i32}) => { ... }
printExact(v);  // ❌ Error - Vector is not exact {x: i32, y: i32}
```

### 8.3 Can a Record satisfy an Interface?

**No.**

Interfaces in Zena are **Nominal**. A type must explicitly declare that it implements an interface. Since Records are anonymous and structural, they cannot declare implementation.

```zena
interface IPoint {
  get x(): i32;
}

let r = {x: 10};
// ❌ Error: Record does not explicitly implement IPoint.
let i: IPoint = r;
```

However, records and interfaces serve different purposes:

- **Records**: Data transfer, option bags, multiple returns
- **Interfaces**: Contracts, abstraction, polymorphic behavior

### 8.4 Nominal vs. Structural Philosophy

Zena adopts a **Hybrid** approach:

- **Nominal (Classes/Interfaces)**: Used for defining application architecture, domain models, and behavior. Ensures safety and clear intent.
- **Structural (Records/Tuples)**: Used for transient data, function arguments, and return values. Ensures convenience and flexibility. Width subtyping provides TypeScript-like ergonomics.

Records behave like interfaces in terms of subtyping rules, but maintain their identity as lightweight data containers. This design provides:

- Familiar semantics for JS/TS developers
- Flexible option-bag patterns
- Optimization opportunities through dispatch elimination

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
- [x] **Width Subtyping**: Update `isAssignable` to allow width subtyping (source has ≥ fields of target).
- [x] **Member Access**: Check valid field access on records and index access on tuples.

### Phase 3: Optional Fields

- [x] **Parser**: Parse `foo?: Type` syntax in record types.
- [x] **Type Checker**: Track optional vs required fields in `RecordType.optionalProperties`. Updated `isAssignableTo` to allow missing optional fields.
- [x] **Narrowing**: Skipped - use `if let` for optional field access instead of `"field" in record` operator.
- [x] **Destructuring Defaults**: Destructuring an optional field REQUIRES a default value (`let {foo = default} = record`). This avoids boxing primitives - the "absent" case is handled by the default, not by nullable types.

### Phase 4: Code Generator (Dispatch-based)

- [x] **Fat Pointer Types**: Records use fat pointers `(struct (field anyref) (field (ref $vtable)))` with vtables containing getter functions for field access.
- [x] **Vtable Generation**: Getter functions cast anyref to concrete struct type and extract fields. Supports nested record adaptation for width subtyping.
- [x] **Record Literals**: Generate concrete struct + wrap in fat pointer with appropriate vtable.
- [x] **Field Access**: Use vtable dispatch to access fields via getter call_ref.
- [x] **Width Subtyping**: When passing wider record to narrower parameter, rewrap fat pointer with target vtable. Skip adaptation when types match exactly.
- [x] **Destructuring**: Handle fat pointer records in pattern matching and destructuring.

### Phase 5: Dispatch Optimization

- [ ] **Literal Optimization**: When literal shape matches target exactly, use direct access.
- [ ] **Flow Analysis**: Track concrete types through the program.
- [ ] **Inlining Integration**: After inlining, re-analyze for optimization opportunities.

### Phase 6: Exact Record Types

- [ ] **Parser**: Parse exact type syntax (TBD: `exact {...}`, `{...}!`, or `#[exact]`).
- [ ] **Type Checker**: Exact types reject width subtyping and optional fields.
- [ ] **Code Generator**: Exact types use direct `struct.get` - no dispatch.

### Phase 7: Argument Explosion (Multi-value optimization)

- [ ] **Argument Explosion**:
  - Detect functions accepting records with known shapes.
  - Rewrite function signature to flatten parameters.
  - Rewrite call sites to pass individual fields.
- [ ] **Multi-Value Return**:
  - Detect functions returning records/tuples.
  - Rewrite function signature to return multiple values.
  - Rewrite return statements.
  - Rewrite call sites to bind multiple results.

### Phase 8: Host Interop

- [ ] **Thunks**: Generate JS wrapper functions for exported functions using records/tuples.
