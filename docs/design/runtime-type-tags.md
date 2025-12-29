# Runtime Type Tags for Generic Specialization

## Problem Statement

Zena faces a tension between two goals for generic types:

1. **Type Safety**: The `is` operator should distinguish between `Box<Meters>` and `Box<Seconds>` where `Meters` and `Seconds` are distinct types aliasing the same underlying type (`i32`).

2. **Code Sharing**: Generic class specializations like `Box<Meters>` and `Box<Seconds>` should share the same WASM struct type and generated code (since they have identical runtime representation), rather than generating duplicate code for each distinct type name.

### Current State

After recent changes to support self-referential mixins (using WASM-GC recursive type groups), each distinct type parameter creates a separate struct type. This achieves goal #1 (type safety) but not goal #2 (code sharing).

```zena
distinct type Meters = i32;
distinct type Seconds = i32;

let m = new Box<Meters>(10 as Meters);
let s = new Box<Seconds>(5 as Seconds);

// Currently: works correctly, returns false
m is Box<Seconds>; // false ✅

// But: generates two separate WASM structs:
// $Box<Meters> with fields: [vtable, value: i32]
// $Box<Seconds> with fields: [vtable, value: i32]
// And duplicate methods for each specialization
```

## Key Insight: Distinct Types Are Erased

A critical observation is that **distinct types aliasing primitives cannot be distinguished at runtime**:

```zena
distinct type Meters = i32;
distinct type Seconds = i32;

let check = (v: Meters | Seconds): boolean => {
  return v is Seconds;  // Always returns true!
};

check(10 as Meters);  // Returns true, not false!
```

This is because `Meters` and `Seconds` both erase to `i32` at the WASM level. There's no runtime type information attached to primitive values—they're just raw bits.

### Why Primitives Can't Be Tagged

A raw `i32` is just 32 bits. There's no "header" or "metadata slot" like objects have in languages with managed runtimes. To attach type information to a primitive, you must **box it**—wrap it in a struct:

```wasm
;; Untagged (current): just the raw value
(local $meters i32)

;; Tagged (requires boxing): struct with implicit type from struct type
(type $Meters (struct (field $value i32)))
(local $meters (ref $Meters))
```

Boxing has costs:

- **Allocation**: Each value requires heap allocation
- **Indirection**: Accessing the value requires a struct.get
- **Nullability**: Reference types can be null (unless using `(ref $T)` vs `(ref null $T)`)
- **Memory**: Each boxed value carries GC overhead

This is why distinct types over primitives are designed as zero-cost abstractions—they provide compile-time safety without runtime overhead.

### Implications

1. **`is` checks on unions of distinct types are meaningless**: If `v: Meters | Seconds`, the check `v is Meters` vs `v is Seconds` cannot be distinguished at runtime.

2. **Boxing creates distinguishability**: `Box<Meters>` and `Box<Seconds>` _can_ be distinguished because they are separate struct types (or could carry type tags).

3. **Inconsistency**: It's philosophically inconsistent that `m is Seconds` is indistinguishable for raw values but distinguishable for boxed values.

## Design Options

### Option 1: Status Quo (Full Monomorphization)

Keep the current behavior where each generic instantiation creates a separate WASM struct type.

**Pros:**

- Simple implementation
- `is` checks work via native WASM `ref.test` instruction (O(1))
- No runtime overhead for type checks
- Boxed distinct types are distinguishable

**Cons:**

- Code duplication for semantically identical types
- Larger binary size
- Philosophically inconsistent: `Box<Meters>` distinguishes what raw `Meters` cannot

**When to use:** When binary size is not a concern and maximum `is` check performance is required.

### Option 2: Erasure with Runtime Type Tags

Share WASM struct types for generic instantiations with identical runtime representations, but store a "type tag" field to enable `is` checks.

```wasm
;; Single shared struct for all Box<T> where T: i32-sized
(type $Box_i32_shared (struct
  (field $vtable eqref)
  (field $type_tag i32)      ;; NEW: identifies the specific instantiation
  (field $value i32)
))
```

**Type Tag Assignment:**

Each unique generic instantiation receives a unique integer ID at compile time. This includes instantiations with distinct types that erase to the same underlying type:

```zena
distinct type Meters = i32;
distinct type Seconds = i32;
```

```
Box<i32>     → type_tag = 0
Box<Meters>  → type_tag = 1  // Different from Box<i32>!
Box<Seconds> → type_tag = 2  // Different from Box<Meters>!
Box<u32>     → type_tag = 3
```

The key insight: even though `Meters`, `Seconds`, and `i32` all have the same WASM representation (`i32`), each _named type_ gets its own tag. This preserves the semantic distinction at runtime.

**`is` Check Implementation:**

```wasm
;; m is Box<Seconds>
(if (ref.test $Box_i32_shared (local.get $m))
  (then
    (i32.eq
      (struct.get $Box_i32_shared $type_tag
        (ref.cast $Box_i32_shared (local.get $m)))
      (i32.const 2)))  ;; type_tag for Box<Seconds>
  (else
    (i32.const 0)))
```

**Pros:**

- Significant code sharing (all `i32`-backed boxes share one struct and methods)
- Reduced binary size
- Maintains type distinguishability for boxed values

**Cons:**

- Runtime overhead: extra field read + comparison for `is` checks
- Memory overhead: extra i32 field per instance
- Complexity: tag assignment and tracking

### Option 3: Erasure Without Tags (Static-Only Distinction)

Share struct types AND give up on runtime distinguishability for type parameters that erase identically.

```zena
// These would share the same struct type
let m: Box<Meters> = new Box<Meters>(10 as Meters);
let s: Box<Seconds> = new Box<Seconds>(5 as Seconds);

// This would be a compile error or always true
m is Box<Seconds>;  // Error: Cannot distinguish Box<Meters> from Box<Seconds> at runtime
```

**Pros:**

- Maximum code sharing
- Consistent with primitive behavior (if `Meters` and `Seconds` are indistinguishable as primitives, they should be indistinguishable when boxed)
- Simpler mental model

**Cons:**

- Loss of runtime type safety for some use cases
- Breaking change from current behavior

### Option 4: Opt-In Tags via Decorator/Modifier

Allow users to explicitly opt into runtime distinguishability when needed.

#### For Generic Classes (Viable)

```zena
// Default Box: erased type parameters, code sharing
class Box<T> { value: T; }

// Tagged Box: preserves type parameter identity via tag field
@tagged class TaggedBox<T> { value: T; }
```

This works because the class struct can include an extra `$type_tag` field.

**How tags are assigned:**

```zena
distinct type Meters = i32;
distinct type Seconds = i32;

// All these share the SAME struct type ($TaggedBox_i32_shared)
// but get DIFFERENT type_tag values:
new TaggedBox<i32>(5);      // type_tag = 0
new TaggedBox<Meters>(5);   // type_tag = 1
new TaggedBox<Seconds>(5);  // type_tag = 2

// Now `is` checks work:
let m = new TaggedBox<Meters>(10 as Meters);
m is TaggedBox<Seconds>;  // false (compares tag 1 != 2)
m is TaggedBox<Meters>;   // true  (compares tag 1 == 1)
```

**Tag granularity:**

The tag distinguishes every unique _source-level_ type parameter combination, not just the erased representation. So:

| Instantiation        | Erased To                  | Type Tag |
| -------------------- | -------------------------- | -------- |
| `TaggedBox<i32>`     | `$TaggedBox_i32_shared`    | 0        |
| `TaggedBox<Meters>`  | `$TaggedBox_i32_shared`    | 1        |
| `TaggedBox<Seconds>` | `$TaggedBox_i32_shared`    | 2        |
| `TaggedBox<u32>`     | `$TaggedBox_i32_shared`    | 3        |
| `TaggedBox<f32>`     | `$TaggedBox_f32_shared`    | 0        |
| `TaggedBox<string>`  | `$TaggedBox_string_shared` | 0        |
| `TaggedBox<Animal>`  | `$TaggedBox_ref_shared`    | 0        |
| `TaggedBox<Dog>`     | `$TaggedBox_ref_shared`    | 1        |

Note that tags are scoped per shared struct type. `TaggedBox<i32>` (tag 0) and `TaggedBox<f32>` (tag 0) don't conflict because they use different struct types, so the `ref.test` already distinguishes them.

**Optimization: When are tags unnecessary?**

Type tags are only needed when multiple source-level types erase to the same WASM representation AND cannot be distinguished by other means. Consider:

1. **Reference type parameters don't need tags** (usually):

   ```zena
   Box<Animal>  vs  Box<Dog>
   ```

   Even if both erase to `$Box_ref_shared`, we can distinguish them by examining the _contained value_:

   ```wasm
   ;; box is Box<Dog>?
   ;; Check: is box a Box_ref, AND is box.value a Dog?
   (if (ref.test $Box_ref_shared (local.get $box))
     (then
       (ref.test $Dog
         (struct.get $Box_ref_shared $value
           (ref.cast $Box_ref_shared (local.get $box))))))
   ```

   The `ref.test $Dog` on the contained value provides distinguishability without a tag.

2. **Primitive/distinct type parameters DO need tags**:

   ```zena
   Box<Meters>  vs  Box<Seconds>  // Both contain i32, can't inspect the value
   ```

3. **Multi-parameter generics: only some parameters need tags**:

   ```zena
   distinct type Meters = i32;
   distinct type Seconds = i32;

   Map<Animal, Meters>  vs  Map<Animal, Seconds>
   ```

   - `K = Animal` → reference type, distinguished by `ref.test` on keys
   - `V = Meters|Seconds` → both erase to `i32`, needs a tag

   So `Map` only needs a tag for `V`, not `K`:

   ```wasm
   (type $Map_ref_i32_shared (struct
     (field $vtable eqref)
     (field $v_type_tag i32)  ;; Only for V, not K
     (field $buckets ...)
   ))
   ```

4. **No tag field needed at all for `Box<MyObject>`**:

   ```zena
   Box<MyObject>  vs  Box<OtherObject>
   ```

   Both are reference types. Either:
   - They have separate struct types (monomorphization), OR
   - They share `$Box_ref_shared` but can be distinguished by `ref.test` on the value

   **⚠️ CAVEAT: Distinct types over reference types break this!**

   ```zena
   // Module A
   new Box<MyObject>(obj);

   // Module B
   distinct type MySpecialObject = MyObject;
   new Box<MySpecialObject>(obj);
   ```

   Here `MySpecialObject` erases to `MyObject` at runtime—there's no separate WASM struct type for distinct type aliases. `ref.test $MyObject` returns true for both! Without whole-program analysis, Module A can't know that Module B will create a distinct alias.

   **Options to handle this:**

   a. **Conservative: Tags for all type parameters** — Even reference type parameters get tags, because someone might create a distinct alias. This ensures code sharing always works but adds overhead.

   b. **Whole-program analysis (WPA)** — During linking/bundling, analyze all instantiations to determine which parameters actually need tags. Only add tags where distinct aliases exist.

   c. **No sharing for distinct types over references** — If you use `distinct type X = SomeClass`, instantiations with `X` are always fully monomorphized. Plain class type arguments can share code tag-free.

   d. **Require explicit opt-in** — Only `@tagged class` gets sharing+tags. Regular classes always monomorphize, avoiding the problem entirely.

**On Whole-Program Analysis:**

WPA is not something to avoid—it's natural for Zena since we compile to a single WASM binary. Many optimizations already require it (dead code elimination, tree-shaking). The key principle:

> **WPA should be an optimization, not a correctness requirement.**

The program must work correctly _without_ WPA (using conservative behavior), and WPA makes it _better_ (smaller binary, fewer tags). This means:

- **Without WPA (default)**: Use conservative tagging strategy. Either:
  - Tags for all type parameters (if sharing is the default), OR
  - Full monomorphization (if performance is the default)
- **With WPA (opt-in `-O` flag)**: Analyze all instantiations across all modules:
  - Remove unnecessary tag fields where no distinct alias exists
  - Merge identical struct types
  - Eliminate redundant `is` check code

This approach has good properties:

- **Incremental compilation**: Works without WPA, just less optimal
- **Library distribution**: Libraries can be distributed as source or pre-analyzed IR
- **Debug builds**: Fast compilation without WPA
- **Release builds**: WPA pass produces optimal output

**Summary of when tags are needed:**

| Type Parameter           | Needs Tag? | Reason                                               |
| ------------------------ | ---------- | ---------------------------------------------------- |
| Primitive (`i32`, `f32`) | Rarely     | Different WASM types already distinguish them        |
| Distinct over primitive  | **Yes**    | `Meters` and `Seconds` both erase to `i32`           |
| Reference type (class)   | **Maybe**  | Safe only if no distinct alias exists (requires WPA) |
| Distinct over reference  | **Yes**    | `ref.test` can't distinguish from base type          |

#### For Distinct Types Over Primitives (Problematic)

```zena
// This CANNOT work without boxing:
@tagged distinct type Meters = i32;  // ❌ How do we tag raw bits?
```

**The fundamental problem**: A raw `i32` is just 32 bits on the stack or in a local. There's nowhere to attach metadata. To make a distinct primitive type distinguishable, we'd have to **box it**:

```wasm
;; A "tagged" Meters would need to become a struct:
(type $Meters (struct
  (field $value i32)
))
;; The tag is implicit in the struct type itself
```

But this defeats the purpose of distinct types, which are meant to be zero-cost abstractions over primitives.

#### Possible Interpretations of `@tagged` on Primitives

1. **Compiler Error**: Simply disallow `@tagged` on distinct types over primitives.

   ```zena
   @tagged distinct type Meters = i32;  // ERROR: Cannot tag primitive types
   ```

2. **Implicit Boxing**: `@tagged` converts the distinct type into a class.

   ```zena
   @tagged distinct type Meters = i32;
   // Desugars to:
   final class Meters { value: i32; #new(v: i32) { this.value = v; } }
   ```

   This changes the semantics significantly—`Meters` is now a reference type, requires allocation, and can be `null`.

3. **Wrapper Class Generation**: Generate both the raw type and a boxed version.
   ```zena
   @tagged distinct type Meters = i32;
   // Generates:
   // - `Meters` as erased i32 (for stack usage)
   // - `BoxedMeters` class (for when you need distinguishability)
   ```

**Recommendation**: Option 1 (Compiler Error) is the simplest and most honest. If users need a distinguishable unit type, they should explicitly define a class:

```zena
// Explicit: user understands they're getting a reference type
final class Meters {
  value: i32;
  #new(v: i32) { this.value = v; }
}
```

**Pros:**

- User chooses the trade-off
- Default behavior is efficient
- Advanced users get full control

**Cons:**

- More complex language surface
- Users must understand the distinction
- `@tagged` on distinct primitives either errors or has surprising semantics

### Option 5: Hybrid Approach (Tier-Based)

Different types of `is` checks use different mechanisms:

| Check Type                             | Implementation                         | Performance               |
| -------------------------------------- | -------------------------------------- | ------------------------- |
| `x is Box` (non-generic)               | `ref.test`                             | O(1), fast                |
| `x is Box<i32>` (primitive type arg)   | `ref.test` on shared struct            | O(1), fast                |
| `x is Box<Meters>` (distinct type arg) | Requires tag if opted-in               | O(1), but needs tag field |
| `x is Box<Animal>` (class type arg)    | TypeInfo comparison or separate struct | Varies                    |

This approach from [generic-specialization-strategy.md](generic-specialization-strategy.md) could be extended to handle distinct types.

## Recommendation

### Primary Recommendation: Option 3 + Static Warnings

1. **Share struct types** for generic instantiations with identical WASM representations.

2. **Produce compile-time errors** when using `is` on types that cannot be distinguished at runtime:

```zena
distinct type Meters = i32;
distinct type Seconds = i32;

let check = (v: Meters | Seconds): boolean => {
  return v is Seconds;  // ERROR: Meters and Seconds are indistinguishable at runtime
};

let boxCheck = (v: Box<Meters> | Box<Seconds>): boolean => {
  return v is Box<Seconds>;  // ERROR: Box<Meters> and Box<Seconds> share the same representation
};
```

3. **Provide an escape hatch** (Option 4) for users who need distinguishability:

```zena
@tagged distinct type Meters = i32;
// or
@tagged class TaggedBox<T> { ... }
```

### Rationale

1. **Consistency**: Raw distinct types cannot be distinguished, so boxed distinct types shouldn't be distinguishable by default either.

2. **Performance**: The default path has no runtime overhead.

3. **Safety**: Compile-time errors prevent developers from writing code that appears to work but doesn't behave as expected.

4. **Flexibility**: The `@tagged` decorator allows advanced users to opt into the behavior when needed.

## Implementation Plan

### Phase 1: Static Analysis for Indistinguishable Types

1. Implement `isDistinguishableAtRuntime(typeA: Type, typeB: Type): boolean` in the checker.

2. In `checkIsExpression`, when the expression type is a union:
   - Extract all union members
   - For each pair of members, check if they're distinguishable
   - If any pair is indistinguishable, report an error

3. In `checkIsExpression`, when checking if `expr is TargetType`:
   - Get the source type of `expr`
   - If source and target are different types that erase identically, report an error

### Phase 2: Type Erasure in Codegen

1. Modify `getSpecializedName` to erase distinct types to their underlying types:

```typescript
// Current behavior
getSpecializedName('Box', [MetersType]) → 'Box<Meters>'
getSpecializedName('Box', [SecondsType]) → 'Box<Seconds>'

// New behavior (for code sharing)
getSpecializedName('Box', [MetersType]) → 'Box<i32>'
getSpecializedName('Box', [SecondsType]) → 'Box<i32>'
```

2. Ensure method bodies are generated only once per erased specialization.

### Phase 3: Optional Tags (Future)

1. Add `@tagged` decorator support to the parser and checker.

2. For tagged distinct types, generate unique type IDs at compile time.

3. For tagged generic classes:
   - Add `$type_tag` field to struct
   - Pass type tag in constructor
   - Check type tag in `is` expressions

## Could `@tagged` Be Userland Sugar?

An interesting design question: could `@tagged` be implemented as a library feature (perhaps a mixin) rather than a compiler intrinsic?

### The Core Primitive: `TypeId<T>`

The key primitive needed is a way to **reify a type as a compile-time constant**:

```zena
// Hypothetical intrinsic: returns a unique i32 for each distinct type
const metersId = TypeId<Meters>;   // e.g., 42
const secondsId = TypeId<Seconds>; // e.g., 43
const i32Id = TypeId<i32>;         // e.g., 1

// These are compile-time constants, not runtime calls
```

With `TypeId<T>`, users could write:

```zena
class TaggedBox<T> {
  #typeTag: i32 = TypeId<T>;  // Compile-time constant per instantiation
  value: T;

  #new(v: T) {
    this.value = v;
  }

  isType<U>(): boolean {
    return this.#typeTag == TypeId<U>;
  }
}

// Usage
let m = new TaggedBox<Meters>(10 as Meters);
m.isType<Seconds>();  // false - compares 42 != 43
m.isType<Meters>();   // true  - compares 42 == 42
```

### As a Mixin

Even better, this could be a reusable mixin:

```zena
mixin Tagged<T> {
  #typeTag: i32 = TypeId<T>;

  hasTypeArg<U>(): boolean {
    return this.#typeTag == TypeId<U>;
  }
}

class Box<T> with Tagged<T> {
  value: T;
  #new(v: T) { this.value = v; }
}

// Usage
let m = new Box<Meters>(10 as Meters);
m.hasTypeArg<Seconds>();  // false
```

### The `is` Operator Problem

The limitation: this doesn't integrate with the `is` operator. You'd have:

```zena
m is Box<Seconds>;      // Uses WASM ref.test - would be TRUE (same struct type)
m.hasTypeArg<Seconds>(); // Uses typeTag field - would be FALSE (correct)
```

To make `is` work with type tags, we'd need one of:

1. **Magic field name**: `is` automatically checks `#typeTag` if present

   ```zena
   // Compiler recognizes #typeTag field and generates:
   // ref.test && (this.#typeTag == TypeId<TargetType>)
   ```

2. **Operator customization**: Allow classes to define `is` behavior

   ```zena
   class Box<T> {
     operator is<U>(): boolean {
       return this.#typeTag == TypeId<U>;
     }
   }
   ```

3. **`is` remains structural, use methods for semantic checks**
   ```zena
   // Accept that `is` checks struct type (physical)
   // Use methods for type argument checks (logical)
   if (m is Box && m.hasTypeArg<Seconds>()) { ... }
   ```

### Can `operator is` Be Zero-Cost for Non-Overriders?

In JavaScript, `Symbol.hasInstance` slows down ALL `instanceof` checks because the engine can't know at compile time which objects might override it. But Zena is statically typed—we know at compile time exactly which types override `operator is`.

**Compilation strategy:**

```zena
// Regular class - no override
class Animal { name: string; }

// Tagged class - overrides `is`
class Box<T> {
  #typeTag: i32 = TypeId<T>;
  value: T;

  operator is<U>(): boolean {
    return this.#typeTag == TypeId<U>;
  }
}
```

At each `is` call site, the compiler knows the target type:

```zena
x is Animal;       // Animal has no override → ref.test $Animal
x is Box<Meters>;  // Box has override → custom codegen
```

**Generated code:**

```wasm
;; x is Animal (no override - unchanged, fast path)
(ref.test $Animal (local.get $x))

;; x is Box<Meters> (has override - custom codegen)
(if (result i32) (ref.test $Box (local.get $x))
  (then
    ;; Call the override logic inline or as function
    (i32.eq
      (struct.get $Box $typeTag (ref.cast $Box (local.get $x)))
      (i32.const 42)))  ;; TypeId<Meters>
  (else
    (i32.const 0)))
```

**Key insight:** The dispatch is resolved at compile time, not runtime:

| Target Type   | Has Override? | Generated Code                   |
| ------------- | ------------- | -------------------------------- |
| `Animal`      | No            | `ref.test $Animal`               |
| `Dog`         | No            | `ref.test $Dog`                  |
| `Box<Meters>` | Yes           | `ref.test $Box && typeTag == 42` |
| `Box<i32>`    | Yes           | `ref.test $Box && typeTag == 7`  |

**Properties:**

- **Non-overriders pay nothing**: `x is Animal` compiles to plain `ref.test`
- **No runtime dispatch**: Compiler knows at each site whether to use custom logic
- **Inlinable**: Override logic can be inlined at the call site
- **Type-safe**: The override signature is checked at compile time

**Comparison to JavaScript:**

|                    | JavaScript           | Zena               |
| ------------------ | -------------------- | ------------------ |
| Override mechanism | `Symbol.hasInstance` | `operator is<U>()` |
| When resolved      | Runtime (every call) | Compile time       |
| Non-overriders     | Still pay check cost | Zero overhead      |
| Override body      | Arbitrary JS         | Statically checked |

This is similar to how C++ handles `operator==`—it's resolved at compile time based on the static types involved, not dispatched at runtime.

### Recommendation: `TypeId<T>` as Intrinsic, Rest in Userland

The minimal compiler addition would be:

1. **Add `TypeId<T>` intrinsic**: Returns a unique `i32` for each distinct type at compile time
2. **Standard library `Tagged<T>` mixin**: Provides the field and helper methods
3. **`is` unchanged**: Continues to use WASM struct type checks

This keeps the compiler simple while giving users the tools to build their own tagging schemes. The trade-off is that `is` doesn't automatically use tags—users call `.hasTypeArg<U>()` instead.

If we later want `is` integration, we can add the magic field or operator customization as a follow-up feature.

### `TypeId` Implementation Notes

```zena
// TypeId<T> produces a compile-time constant i32
// The compiler assigns sequential IDs to each unique type encountered

TypeId<i32>           // 0
TypeId<i64>           // 1
TypeId<f32>           // 2
TypeId<f64>           // 3
TypeId<string>        // 4
TypeId<Meters>        // 5 (distinct from i32!)
TypeId<Seconds>       // 6
TypeId<Box<i32>>      // 7
TypeId<Box<Meters>>   // 8 (distinct from Box<i32>!)
```

Key properties:

- **Deterministic**: Same type always gets same ID within a compilation
- **Distinct types get distinct IDs**: Even if they erase to the same WASM type
- **Generic instantiations are distinct**: `Box<Meters>` ≠ `Box<i32>`
- **Zero runtime cost**: It's a constant, not a function call

This is similar to:

- Rust's `TypeId::of::<T>()` (but that's runtime)
- C++'s `typeid` (but that requires RTTI)
- Zig's `@TypeOf` and type comparison

## Impact Analysis

### Binary Size

- **Reduction**: Significant for codebases with many distinct types used as generic parameters.
- **Example**: If a codebase has 10 distinct unit types (`Meters`, `Seconds`, `Kilograms`, etc.) and uses `Box<T>` for all of them, binary size reduction would be ~9x for the Box class code.

### Performance

| Operation              | Current           | After Phase 2 | After Phase 3 (tagged) |
| ---------------------- | ----------------- | ------------- | ---------------------- |
| `new Box<Meters>(...)` | Direct struct.new | Same          | +1 i32 field write     |
| `box is Box<Meters>`   | ref.test          | Compile error | ref.test + i32.eq      |
| `box is Box<_>`        | N/A               | ref.test      | ref.test               |

### Breaking Changes

- Code that relies on `is` checks between indistinguishable boxed types will fail to compile.
- This is intentional—such code was incorrect (would always return true/false regardless of the actual type).

## Alternatives Considered

### Alternative: String-Based Type Names

Store the full type name as a string:

```wasm
(field $type_name (ref $String))  ;; "Box<Meters>"
```

**Rejected because:**

- Much larger memory overhead per instance
- String comparison is slower than integer comparison
- Complicates hash-based operations

### Alternative: Pointer-Based TypeInfo (from generic-specialization-strategy.md)

Store a pointer to a TypeInfo struct:

```wasm
(field $type_info (ref $TypeInfo))
```

**Partially accepted:**

- Good for complex type hierarchies with variance
- Overkill for simple distinct type cases
- Could be used for reference type parameters in the future

### Alternative: Compile-Time-Only Tags

Generate unique struct types but share method code via indirect calls:

**Rejected because:**

- Still doesn't share struct definitions
- Indirect calls have significant overhead

## Open Questions

1. **Should `@tagged` be supported on distinct types over primitives?**
   - **No** (recommended): Produces a compiler error. Users who need distinguishable unit types should define a class explicitly.
   - **Yes, with boxing**: `@tagged distinct type Meters = i32` desugars to a class. This changes semantics (reference type, nullable, allocation required).
   - See "Option 4" above for detailed analysis.

2. **Should `@tagged` apply to distinct types over reference types?**

   ```zena
   @tagged distinct type UserId = string;
   ```

   - This is more viable since `string` is already a reference type.
   - The "tag" could be the struct type itself (monomorphization) or an actual tag field.
   - But if `string` already has its own struct type, wrapping it in another struct just for tagging adds overhead.
   - **Recommendation**: For distinct types over reference types, monomorphization (separate struct types) is the natural tagging mechanism. No explicit `@tagged` needed.

3. **What about nested generics?**

   ```zena
   Box<Box<Meters>>
   ```

   - If inner `Box<Meters>` erases to `Box<i32>`, the outer box becomes `Box<Box<i32>>`
   - This is consistent and should work.

4. **What about type aliases that don't use `distinct`?**

   ```zena
   type MetersAlias = i32;  // not distinct
   ```

   - Non-distinct aliases already erase fully, so no change needed.

5. **Should we support partial erasure?**

   ```zena
   Map<Meters, Animal>  // First param erases, second doesn't
   ```

   - Yes, this falls out naturally: `Map<i32, Animal>` vs `Map<i32, Dog>` would still be distinguishable via the second type parameter's struct type.

## Related Documents

- [generics.md](generics.md) - Current generics implementation
- [generic-specialization-strategy.md](generic-specialization-strategy.md) - Hybrid approach for reference types
- [types.md](types.md) - Type system design, including distinct types
- [pattern-matching.md](pattern-matching.md) - `is` operator semantics

## Appendix: Current Code References

### `is` Check Codegen

From [expressions.ts#L399](../../../packages/compiler/src/lib/codegen/expressions.ts#L399):

```typescript
function generateIsExpression(ctx, expr, body) {
  // ... handles primitive checks ...

  // For reference types, uses ref.test against the struct type index
  body.push(0xfb, GcOpcode.ref_test);
  body.push(...WasmModule.encodeSignedLEB128(typeIndex));
}
```

### Specialization Naming

From [classes.ts#L2178](../../../packages/compiler/src/lib/codegen/classes.ts#L2178):

```typescript
export function getSpecializedName(name, args, ctx, context) {
  const argNames = args.map((arg) => {
    const resolved = resolveAnnotation(arg, context);
    return getTypeKey(resolved); // Currently preserves distinct type names
  });
  return `${name}<${argNames.join(',')}>`;
}
```

### Class Instantiation

From [classes.ts#L2409](../../../packages/compiler/src/lib/codegen/classes.ts#L2409):

```typescript
export function instantiateClass(
  ctx,
  decl,
  specializedName,
  typeArguments,
  parentContext,
) {
  // Creates a new struct type for each unique specializedName
  // ...
}
```

## Conclusion

The recommended approach (Option 3 + Static Warnings) provides the best balance of:

1. **Consistency**: Boxed and unboxed distinct types behave the same way.
2. **Performance**: No runtime overhead for the common case.
3. **Safety**: Compile-time errors catch subtle bugs.
4. **Flexibility**: `@tagged` escape hatch for advanced use cases.

This approach aligns with Zena's design principles of performance and safety, while providing a clear path for users who need more sophisticated runtime type introspection.
