# Generic Specialization Strategy

## Current Approach: Full Specialization

Currently, Zena creates a separate WASM struct type and methods for each unique generic instantiation:

```
Box<Y1> → struct $Box_Y1 { vtable, value: (ref $Y1) }
Box<Y2> → struct $Box_Y2 { vtable, value: (ref $Y2) }
```

**Pros:**
- Simple implementation
- `is` checks work naturally via WASM struct type checks
- No runtime overhead for type checks

**Cons:**
- Code duplication when type parameters have same runtime representation
- Larger binary size

## Proposed Hybrid Approach: Shared Code with Type Metadata

### Key Insight

For type parameters that map to the same WASM type, we can share the struct type and methods, but preserve type identity for `is` checks.

### Type Parameter Categories

1. **Reference types** (classes, interfaces) → all map to `(ref null $Object)` or similar
2. **Primitive types** (`i32`, `u32`, `f32`, etc.) → each maps to its own WASM type
3. **Boxed primitives** (if we have them) → reference types

### Shared Specialization for Reference Types

```wasm
;; Single struct type for all Box<T> where T is a reference type
(type $Box_ref (struct
  (field $vtable (ref $Box_ref_vtable))
  (field $type_arg (ref $TypeInfo))   ;; NEW: stores the actual T
  (field $value (ref null $Object))   ;; erased to common supertype
))
```

The `$type_arg` field stores a reference to a `TypeInfo` object that describes what `T` actually is.

### TypeInfo Structure

```zena
class TypeInfo {
  name: string;
  // For generic instantiations, stores the type arguments
  typeArgs: FixedArray<TypeInfo>?;
  // For classes, stores the class declaration info
  classInfo: ClassInfo?;
}
```

### How `is` Checks Work

```zena
let box: Box<Animal> = ...;

// Current: struct type check
// box is Box<Dog>  →  (ref.test $Box_Dog (local.get $box))

// Hybrid: type info comparison
// box is Box<Dog>  →  typeInfoEquals(box.$type_arg, TypeInfo_Dog)
```

### When to Share vs Specialize

| Type Parameter | WASM Representation | Strategy |
|---------------|---------------------|----------|
| `i32` | `i32` | Specialize (different size) |
| `u32` | `i32` | Could share with `i32` (same WASM type) |
| `i64` | `i64` | Specialize |
| `f32` | `f32` | Specialize |
| `f64` | `f64` | Specialize |
| `SomeClass` | `(ref null $SomeClass)` | Share (all refs) |
| `SomeInterface` | `(ref null $Object)` | Share |
| `[i32, string]` (tuple) | `(ref $Tuple_i32_string)` | Specialize |
| `{x: i32}` (record) | `(ref $Record_x_i32)` | Specialize |

### Implementation Considerations

#### 1. Constructor Changes

When creating `new Box<Dog>(myDog)`, we need to pass the TypeInfo:

```wasm
;; Before (full specialization)
(call $Box_Dog_new (local.get $myDog))

;; After (shared with type info)
(call $Box_ref_new 
  (global.get $TypeInfo_Dog)  ;; type argument info
  (local.get $myDog))
```

#### 2. Method Access

Methods that return `T` need to downcast from the erased type:

```wasm
;; Box.get(): T
;; Before: returns (ref null $Dog) directly
;; After: returns (ref null $Object), caller may need to cast

(func $Box_ref_get (param $this (ref $Box_ref)) (result (ref null $Object))
  (struct.get $Box_ref $value (local.get $this)))
```

The caller knows statically what `T` is, so it can insert the appropriate cast.

#### 3. TypeInfo Global Creation

For each unique type, create a global TypeInfo:

```wasm
(global $TypeInfo_Dog (ref $TypeInfo)
  (struct.new $TypeInfo
    (string.const "Dog")
    (ref.null $FixedArray_TypeInfo)  ;; no type args
    (global.get $ClassInfo_Dog)))

(global $TypeInfo_Box_Dog (ref $TypeInfo)
  (struct.new $TypeInfo
    (string.const "Box")
    (array.new_fixed $FixedArray_TypeInfo 1
      (global.get $TypeInfo_Dog))    ;; type args: [Dog]
    (global.get $ClassInfo_Box)))
```

### Trade-offs

#### Pros of Hybrid Approach
- **Smaller code size**: One set of methods for all reference-type instantiations
- **Faster compilation**: Fewer methods to generate
- **Still type-safe**: `is` checks work via TypeInfo comparison

#### Cons of Hybrid Approach
- **Runtime overhead**: Extra indirection for `is` checks
- **Memory overhead**: TypeInfo globals for each instantiation
- **Complexity**: More complex codegen
- **Potential for subtle bugs**: Type erasure can be tricky

### i32 vs u32 Question

Should `Box<i32>` and `Box<u32>` share code?

**Arguments for sharing:**
- Same WASM representation (`i32`)
- Reduces code size

**Arguments against sharing:**
- Semantically different (signed vs unsigned)
- `is` checks might need to distinguish them
- Operations behave differently (division, comparison)

**Recommendation:** Keep them separate for now. The semantic difference matters, and the code size savings are minimal for primitives.

### Literal Types and Unions

For `Box<'a' | 'b'>` vs `Box<string>`:
- Both erase to `string` at runtime
- Could share the same struct type
- TypeInfo would store the union type for `is` checks

This is where the hybrid approach shines - we don't need separate code, but we preserve the type distinction.

## Implementation Plan

### Phase 1: Analysis
1. Categorize type parameters by their WASM representation
2. Group instantiations that can share code

### Phase 2: TypeInfo Infrastructure
1. Define TypeInfo structure
2. Generate TypeInfo globals for all types
3. Implement type equality checking

### Phase 3: Shared Specialization
1. Modify struct generation to use erased types for shareable params
2. Add type_arg field to structs
3. Update `is` checks to use TypeInfo comparison

### Phase 4: Optimization
1. Inline TypeInfo comparisons where possible
2. Cache common TypeInfo checks
3. Eliminate TypeInfo for types never used with `is`

## Open Questions

1. **Should we erase to a common Object type or keep some hierarchy?**
   - Erasing to Object is simpler
   - Keeping hierarchy allows some struct type checks

2. **How do we handle variance?**
   - `Box<Dog>` assignable to `Box<Animal>`?
   - TypeInfo comparison needs to handle subtyping

3. **What about generic methods inside generic classes?**
   - `class Box<T> { map<U>(f: (T) => U): Box<U> }`
   - Potentially nested type parameters

4. **Dead code elimination with shared code?**
   - If only `Box<Dog>` is used, we still generate shared `Box_ref` code
   - May need to track which type instantiations are actually used

## Optimizing `is` Checks

Not all `is` checks need to examine type arguments. We can use a tiered approach:

### Tier 1: Fast WASM Struct Checks (No Type Args)

These can use native WASM `ref.test`:

```zena
x is i32           // primitive check - inline WASM type check
x is Map           // non-generic class check - ref.test $Map
x is Iterable      // interface check - ref.test or vtable check
```

Generated WASM:
```wasm
;; x is Map (any Map, don't care about type args)
(ref.test $Map_ref (local.get $x))
```

### Tier 2: Wildcard/Existential Checks

When you only care about the base type, not the specific type arguments:

```zena
x is Map<unknown, unknown>  // any Map
x is Box<_>                 // any Box (if we support _ syntax)
x is FixedArray<?>          // any FixedArray
```

These also use fast WASM struct checks since we're only checking the "shape":

```wasm
;; x is Map<unknown, unknown>
(ref.test $Map_ref (local.get $x))  ;; same as "x is Map"
```

### Tier 3: Partial Type Arg Checks

Check some type arguments but not others:

```zena
x is Map<string, unknown>  // any Map with string keys
```

Generated code:
```wasm
;; x is Map<string, unknown>
(if (ref.test $Map_ref (local.get $x))
  (then
    ;; Check first type arg only
    (call $typeInfoEquals
      (struct.get $Map_ref $type_arg_0 (ref.cast $Map_ref (local.get $x)))
      (global.get $TypeInfo_string))))
```

### Tier 4: Full Type Arg Checks (Slowest)

Only when checking specific generic instantiation:

```zena
x is Map<string, Dog>  // specific instantiation
```

Generated code:
```wasm
;; x is Map<string, Dog>
(if (ref.test $Map_ref (local.get $x))
  (then
    (call $typeInfoEquals
      (struct.get $Map_ref $type_args (ref.cast $Map_ref (local.get $x)))
      (global.get $TypeInfo_Map_string_Dog))))
```

### Optimization: Cache Common TypeInfo Comparisons

For hot paths, we could generate specialized comparison functions:

```wasm
;; Specialized check for "is Map<string, Dog>"
(func $is_Map_string_Dog (param $x (ref null $Object)) (result i32)
  (if (ref.test $Map_ref (local.get $x))
    (then
      (return (call $typeInfoEquals_Map_string_Dog
        (struct.get $Map_ref $type_args (ref.cast $Map_ref (local.get $x))))))
    (else (return (i32.const 0)))))
```

### Summary of `is` Check Performance

| Pattern | Check Type | Performance |
|---------|-----------|-------------|
| `x is i32` | Primitive | Inline WASM |
| `x is Dog` | Non-generic class | Fast `ref.test` |
| `x is Map` | Generic base | Fast `ref.test` |
| `x is Map<unknown, unknown>` | Wildcard | Fast `ref.test` |
| `x is Map<string, unknown>` | Partial | `ref.test` + 1 TypeInfo check |
| `x is Map<string, Dog>` | Full | `ref.test` + full TypeInfo check |

This tiered approach means most `is` checks remain fast, and only fully-specified generic instantiation checks pay the TypeInfo comparison cost.
