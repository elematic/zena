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
  name: String;
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

| Type Parameter          | WASM Representation       | Strategy                                |
| ----------------------- | ------------------------- | --------------------------------------- |
| `i32`                   | `i32`                     | Specialize (different size)             |
| `u32`                   | `i32`                     | Could share with `i32` (same WASM type) |
| `i64`                   | `i64`                     | Specialize                              |
| `f32`                   | `f32`                     | Specialize                              |
| `f64`                   | `f64`                     | Specialize                              |
| `SomeClass`             | `(ref null $SomeClass)`   | Share (all refs)                        |
| `SomeInterface`         | `(ref null $Object)`      | Share                                   |
| `(i32, string)` (tuple) | `(ref $Tuple_i32_string)` | Specialize                              |
| `{x: i32}` (record)     | `(ref $Record_x_i32)`     | Specialize                              |

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

For `Box<'a' | 'b'>` vs `Box<String>`:

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
x is Map<String, unknown>  // any Map with string keys
```

Generated code:

```wasm
;; x is Map<String, unknown>
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
x is Map<String, Dog>  // specific instantiation
```

Generated code:

```wasm
;; x is Map<String, Dog>
(if (ref.test $Map_ref (local.get $x))
  (then
    (call $typeInfoEquals
      (struct.get $Map_ref $type_args (ref.cast $Map_ref (local.get $x)))
      (global.get $TypeInfo_Map_string_Dog))))
```

### Optimization: Cache Common TypeInfo Comparisons

For hot paths, we could generate specialized comparison functions:

```wasm
;; Specialized check for "is Map<String, Dog>"
(func $is_Map_string_Dog (param $x (ref null $Object)) (result i32)
  (if (ref.test $Map_ref (local.get $x))
    (then
      (return (call $typeInfoEquals_Map_string_Dog
        (struct.get $Map_ref $type_args (ref.cast $Map_ref (local.get $x))))))
    (else (return (i32.const 0)))))
```

### Summary of `is` Check Performance

| Pattern                      | Check Type        | Performance                      |
| ---------------------------- | ----------------- | -------------------------------- |
| `x is i32`                   | Primitive         | Inline WASM                      |
| `x is Dog`                   | Non-generic class | Fast `ref.test`                  |
| `x is Map`                   | Generic base      | Fast `ref.test`                  |
| `x is Map<unknown, unknown>` | Wildcard          | Fast `ref.test`                  |
| `x is Map<String, unknown>`  | Partial           | `ref.test` + 1 TypeInfo check    |
| `x is Map<String, Dog>`      | Full              | `ref.test` + full TypeInfo check |

This tiered approach means most `is` checks remain fast, and only fully-specified generic instantiation checks pay the TypeInfo comparison cost.

## Current Compiler Status vs Future Path

### Current State (Bootstrap & Self-Hosted)

- **Classes & Structs**: Both compilers currently use **Full Specialization (Monomorphization)** for class struct layouts and fields. For every concrete class type argument combination (e.g., `Box<i32>`, `Box<String>`), a unique WASM struct layout is generated. There is no shared code layout for reference types yet.
- **Generic Methods on VTables (Type Erasure)**: For generic methods on classes and interfaces (e.g. `map<U>`), the current compilers simplify vtable generation by erasing the method's generic type parameters to `anyref` inside the vtable slot.
  - **Static Dispatch**: Direct calls are monomorphized (e.g., `map_spec_i32`), avoiding boxing. This includes _inferred_ type arguments — the checker records the solved type args on the call's FunctionType and reachability instantiates the `_spec_` copy. Pinned by `tests/language/execution/arrays/generic-method-primitive-mono.zena` with erasure-hostile values (i32 near ±2³¹, f64, U≠T).
  - **Virtual/Interface Dispatch**: NOT IMPLEMENTED (status corrected 2026-07-26). The erased copies (`Array_i32.map` over `anyref`) exist and occupy _class_-vtable slots, but no boxing or unboxing adapters were ever generated, generic methods get no _interface_ vtable slot at all, and both compilers crashed with internal errors on a dispatch site like `(s: Array<i32>).map(f)`. Both checkers now reject it with a NotCallable diagnostic instead (see BUGS.md "Generic interface methods are not virtually dispatchable"; semantics test `interfaces/generic-method-virtual-dispatch.zena`). The diagnostic is a stopgap until §"Generic interface dispatch" below is implemented.

### Future Path (Eliminating Auto-Boxing)

We intend to move to **Pure Monomorphization** to completely eliminate implicit heap allocations:

1. **Remove `any` / Keep `anyref`** (done, 2026-07-30): the dynamically typed `any` is gone; `anyref` is reference-only and rejects primitives, so wrapping is explicit. Pinned by `tests/language/semantics/any/`.
2. **Generic Method VTable Expansion**: Instead of type-erasing generic methods in vtables, the compiler's Reachability Analysis (RTA) will specialize virtual generic method slots. Each reached type argument combination (e.g., `map_spec_i32`, `map_spec_string`) will get its own physical slot in the class/interface vtable, making all virtual generic calls fully concrete and zero-overhead (no auto-boxing or trampolines). See the implementation plan below.

## Generic interface dispatch: implementation plan (2026-07-26)

Ruling: higher-order interface methods like `Array<T>.map<U>` MUST
work — they are table stakes for this language class. Of the two
implementation families, vtable expansion is chosen; erasure is
rejected.

### Why erasure is rejected

A single erased slot (`U → anyref`) fails in two independent ways:

1. **Boxing**: `anyref` cannot hold a raw i32/f64. Every U-typed value
   crossing the slot needs a `Box` allocation and unbox casts —
   including inside the loop body, per element. This contradicts the
   pure-monomorphization pillar (Box exists for unions only).
2. **Representation leak** (the fatal one): `map`'s RESULT type
   mentions U (`Array<U>`). The erased callee returns a
   Array-of-boxed-anyref whose interface struct type is
   `$Array_anyref` — but the caller's static type is
   `Array<i32>`, whose fat pointer and slot signatures are
   DIFFERENT WASM TYPES with unboxed element accessors. Bridging
   requires a wrapper object per boundary crossing that re-boxes and
   unboxes on every access, forever. Erasure does not stay contained
   in the callee; it infects every downstream use of the result.

### The chosen design: per-type-argument slots (whole-program)

Zena is a closed-world, whole-program compiler — the same property
that lets RTA build vtables at all lets it enumerate every (interface
member, type-argument tuple) pair that is ever dispatched:

- **Checker**: inference already solves U at every call site and
  records it on the call's FunctionType (this is what drives the
  existing `_spec_` instantiation for direct calls). Interface call
  sites additionally record the member + type-arg key so reachability
  and both backends can reproduce the slot name — same recipe as
  `setResolvedOverload` for overload selection.
- **Reachability**: `referencedInterfaceMembers` keys grow a
  specialization dimension: `"<ifaceId>.map$<targsKey>"`. When a
  (class, interface) pair meets a referenced specialized member —
  in either discovery order, exactly like today's RTA trigger — the
  class's `map_spec_<targsKey>` is instantiated via the existing
  `instantiateGenericMethod` path (these are the SAME functions
  direct calls already use) plus one dispatch trampoline per
  (class, iface, member, targsKey). New Us discovered late simply
  iterate the fixpoint; layout binds post-fixpoint (ir.md §10.2).
- **VTable/interface struct layout**: the interface struct gains one
  exactly-typed funcref field per reached (member, targsKey). Typed
  slots stay exact — no casts before call*ref, preserving the
  existing dispatch pillar. Slot count is bounded by \_reached*
  combinations; a program that maps to three result types through an
  interface pays three slots, not a combinatorial table.
- **Call sites (both backends)**: interface dispatch resolves the
  slot by member + recorded targsKey instead of member alone.
  Everything else (iface_instance/iface_vtable/struct.get/call_ref)
  is unchanged.

### The one real wrinkle: `this` inside function-typed parameters

`Array.map`'s callback is `(item: T, index: i32, seq: this) => U`.
At the slot level `this` means the INTERFACE fat pointer
(`Array<T>`), but the concrete implementation
(`FixedArray<T>.map_spec_*`) invokes the callback with its raw
receiver. A caller-supplied closure typed `seq: Array<T>` cannot
receive a bare array ref. The dispatch trampoline therefore does
double adaptation:

1. wrap the caller's closure `f` in a synthesized closure `g` where
   `g(item, i, concreteSeq) = f(item, i, iface_pack(concreteSeq))`
   (one closure-pair allocation per virtual call — direct calls pay
   nothing);
2. call the direct `_spec_` implementation with `g`;
3. `iface_pack` the concrete result (`FixedArray<U>`) into the
   declared `Array<U>` fat pointer — the same covariant-result
   packing `:iterator` trampolines do today.

Only parameters whose function type mentions `this` (or otherwise
narrows in the implementation) need the closure wrap; plain `T`
positions are concrete per interface instantiation and pass through.

### The optimization payoff: `a.map(f)` becomes a local loop

The goal for callback APIs is that `a.map((x) => y)` compiles to a
plain loop — devirtualize, inline `map`, prove the closure doesn't
escape, inline the callback. Per-type-argument slots are what make
that pipeline a composition of STANDARD passes; each stage stays
fully typed:

1. **Devirtualize** (three tiers, cheapest first):
   - Concrete receivers (`[1,2,3].map(f)`) never touch a vtable —
     they are direct calls to `map_spec_i32` TODAY, so the dominant
     case starts at step 2 for free.
   - Locally-built fat pointers: `iface_vtable(iface_pack(x, vt))`
     folds to `vt`, and a `vt_slot` load from an immutable vtable
     global with a known initializer folds to a `ref.func` constant —
     a ZIR forwarding/GVN peephole (M3).
   - Whole-program: RTA's reached-implementor sets (ir.md §10.1
     harvest sweep) devirtualize any remaining site with a single
     reached implementor of the interface instantiation.
2. **Inline `map`**: the `_spec_` body is small (alloc, loop,
   `call_ref f`) and — because slots are monomorphized — already
   traffics in raw element types. Standard SSA inlining (M3).
3. **Escape analysis + callback inlining**: after step 2, the
   caller's closure pair `{funcref, context}` and the `call_ref`
   consuming it are in one function. Scalar replacement on the
   non-escaping pair turns the callee into a `ref.func` constant →
   direct call → inline. By-value captures make the context struct
   SROA-friendly; celled captures keep their heap cell (still
   correct, and often itself non-escaping).
4. **Result**: a local loop writing unboxed elements. The result
   array allocation remains (it IS map's value); removing it for
   fused chains like `a.map(f).fold(g, z)` where the intermediate is
   provably non-escaping is loop fusion — a later, separate prize.

Under ERASURE this pipeline breaks at step 2: the inlined body
carries per-element Box allocations, unbox casts, and an
`array (mut anyref)` intermediate, so reaching the fast loop would
additionally require box/unbox cancellation across the closure
boundary and re-typing the result array's heap layout — a
data-representation transformation, i.e. undoing erasure in the
optimizer. Monomorphized slots make the fast loop a pass
composition; erasure makes it a research project.

The `seq: this` trampoline never taxes the optimized path: direct
calls bypass it entirely, and when devirt fires on a virtual site,
inlining the trampoline exposes the direct `_spec_` call and the
closure wrap dies to DCE whenever the callback ignores `seq` (the
common case). Trampolines should be marked always-inline-on-devirt.

### Work items, in landing order

1. Checker: record (member, solved targsKey) at interface call sites;
   both compilers. Keep the NotCallable diagnostic until step 5.
2. RTA: specialized `referencedInterfaceMembers` keys; instantiate
   `_spec_` impls + trampolines at pair×member meet; register the
   result class × result interface pair.
3. Layout: per-(member, targsKey) interface-struct fields, named by
   the same mangling as `_spec_` functions.
4. Backend: slot resolution by member+targsKey (ZIR's
   #lowerInterfaceDispatch takes the same key).
5. Lift the diagnostic; move the semantics test to execution tests
   exercising primitive U through the interface (the erasure-hostile
   value set from generic-method-primitive-mono).
