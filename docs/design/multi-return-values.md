# Multi-Return Values

## Summary

Add support for functions that return multiple values, compiling directly to
WASM's multi-value return feature. This enables zero-allocation iterator
patterns and more ergonomic APIs.

## Motivation

### Current Iterator Pattern

The current `Iterator<T>` interface uses a `next()`/`current` pattern to avoid
allocations:

```zena
interface Iterator<T> {
  next(): boolean;
  current: T { get; }
}

// Usage
while (iter.next()) {
  let item = iter.current;
}
```

This works but is awkward:

- `current` is only valid after `next()` returns `true`
- Two separate operations for what's conceptually one step
- Easy to misuse (calling `current` before `next()`)

### Desired Pattern

With multi-return values:

```zena
interface Iterator<T> {
  next(): (hasMore: boolean, value: T);
}

// Usage
while (let (true, item) = iter.next()) {
  // use item
}
```

This is:

- More ergonomic
- Still zero-allocation (values on WASM stack)
- Self-documenting (can't access value when exhausted)

## WASM Multi-Value Background

WASM has supported multi-value returns since the [multi-value
proposal](https://github.com/WebAssembly/multi-value) (2020):

```wasm
;; Function returning two values
(func $next (result i32 anyref)
  i32.const 1      ;; hasMore
  ref.null any     ;; value
)

;; Caller receives both on the stack
(call $next)
;; Stack now has: [i32, anyref]
```

### Block and Loop Parameters

The multi-value proposal also added **block parameters** - blocks and loops can
now take inputs:

```wasm
;; Block that takes i32 param and returns i64
(block $label (param i32) (result i64)
  i64.extend_i32_s
)

;; Loop with parameters - enables efficient iteration
(loop $iter (param i32) (result i32)  ;; takes accumulator, returns sum
  ;; ... loop body ...
  br_if $iter  ;; branch back with new accumulator value
)
```

This is powerful for iteration because the loop can thread state through
parameters rather than using locals.

## Design

### Syntax: Unboxed Tuple Types

Introduce `(T1, T2, ...)` as an **unboxed tuple type**:

```zena
// Multi-return function
let divide = (a: i32, b: i32): (quotient: i32, remainder: i32) => {
  return (a / b, a % b);
};

// Named fields are optional
let pair = (): (i32, i32) => (1, 2);
```

**Key distinction from boxed tuples:**

- `[i32, i32]` - Boxed tuple, heap-allocated struct
- `(i32, i32)` - Unboxed tuple, exists only on WASM stack

### Destructuring at Call Sites

```zena
// Basic destructuring
let (q, r) = divide(10, 3);

// With type annotations
let (q: i32, r: i32) = divide(10, 3);

// In conditionals
if (let (true, value) = iter.next()) {
  // use value
}

// In while loops
while (let (true, item) = iter.next()) {
  // use item
}
```

### Pattern Matching Integration

```zena
match iter.next() {
  case (true, value) => process(value),
  case (false, _) => done(),
}
```

### Iterator Redesign

```zena
interface Iterator<T> {
  /// Returns (hasMore, currentValue).
  /// When hasMore is false, currentValue is unspecified.
  next(): (boolean, T);
}

interface Iterable<T> {
  iterator(): Iterator<T>;
}
```

**Empty iterator behavior:**

When `hasMore` is `false` (including the first call on an empty collection),
`value` must still be returned but is **unspecified**:

- Reference types (`T` is a class, interface, etc.): returns `null`
- Primitives: returns zero (`0` for `i32`, `0.0` for `f64`, `false` for
  `boolean`)

The caller must not use `value` when `hasMore` is `false`. This is enforced by
the `while (let (true, item) = ...)` pattern - the binding only succeeds when
`hasMore` is `true`.

```zena
// Safe - pattern only matches when hasMore is true
while (let (true, item) = iter.next()) {
  process(item);
}

// Unsafe - explicitly accessing value when exhausted
let (done, value) = iter.next();
if (!done) {
  process(value);  // Fine
}
// value is garbage here, don't use it
```

**Implementation in ArrayIterator:**

```zena
class ArrayIterator<T> implements Iterator<T> {
  #array: array<T>;
  #index: i32;

  next(): (boolean, T) {
    this.#index = this.#index + 1;
    if (this.#index < __array_len(this.#array)) {
      return (true, __array_get(this.#array, this.#index));
    }
    // Return false with unspecified value
    // For reference types, this would be null
    // The compiler generates appropriate "zero" for type T
    return (false, __default<T>());
  }
}
```

The `__default<T>()` intrinsic would return the zero/null value for any type -
similar to Go's zero values or Rust's `Default::default()`.

## Code Generation

### Function Returns

```zena
let divide = (a: i32, b: i32): (i32, i32) => (a / b, a % b);
```

Compiles to:

```wasm
(func $divide (param $a i32) (param $b i32) (result i32 i32)
  local.get $a
  local.get $b
  i32.div_s
  local.get $a
  local.get $b
  i32.rem_s
)
```

### Destructuring Assignment

```zena
let (q, r) = divide(10, 3);
```

Compiles to:

```wasm
(local $q i32)
(local $r i32)
i32.const 10
i32.const 3
call $divide
;; Stack: [quotient, remainder]
local.set $r    ;; Pop remainder
local.set $q    ;; Pop quotient
```

Note: Values are popped in reverse order (LIFO).

### For-Of Loops with Block Parameters

With multi-return iterators, we could compile `for..of` loops using WASM block
parameters:

```zena
for (let item of collection) {
  process(item);
}
```

**Current approach (without block params):**

```wasm
;; Get iterator
call $collection.iterator
local.set $iter

block $break
  loop $continue
    ;; Call next(), get (hasMore, value)
    local.get $iter
    call $Iterator.next
    ;; Stack: [hasMore, value]

    ;; Store value temporarily
    local.set $item

    ;; Check hasMore
    i32.eqz
    br_if $break

    ;; Process item
    local.get $item
    call $process

    br $continue
  end
end
```

**With block parameters:**

```wasm
;; Get iterator and call first next()
call $collection.iterator
local.tee $iter
call $Iterator.next
;; Stack: [hasMore, value]

block $break (param i32 anyref)  ;; Takes hasMore, value
  loop $continue (param i32 anyref)
    ;; Stack top: [hasMore, value]

    ;; Break if !hasMore (leaves value on stack, discarded by block)
    i32.eqz
    br_if $break

    ;; Process current item (value is on stack)
    call $process

    ;; Get next
    local.get $iter
    call $Iterator.next
    ;; Stack: [hasMore, value]

    br $continue
  end
end
drop  ;; Drop final value
```

**Benefits of block parameters:**

- Fewer locals (value stays on stack)
- Cleaner control flow
- Potential for better optimization by WASM engines

**Caveat:** The value must be consumed or explicitly dropped. Works well when
the loop body uses the value exactly once.

### Interface Method Calls

For interface methods returning multi-values, the vtable dispatch works normally

- WASM handles multi-value returns through any call:

```wasm
;; Vtable call returning (i32, anyref)
local.get $this
struct.get $Iterator $vtable
struct.get $Iterator_vtable $next
local.get $this
call_ref (type $next_sig)
;; Stack: [i32, anyref]
```

## Type System

### Unboxed Tuples Are Not First-Class

Unboxed tuples have restrictions:

- Cannot be stored in variables (only destructured immediately)
- Cannot be fields in structs/classes
- Cannot be elements in arrays
- Can only appear as function return types

```zena
// Allowed
let (a, b) = getTuple();

// NOT allowed - unboxed tuples can't be stored
let t = getTuple();  // Error: unboxed tuple must be destructured
let t: (i32, i32) = getTuple();  // Error: same
```

This ensures they compile to stack values, not heap allocations.

### Boxed Tuple Coercion

An unboxed tuple can be explicitly boxed:

```zena
let boxed: [i32, i32] = [getTuple()...];  // Spread into boxed tuple
```

Or with a helper:

```zena
let boxed = box(getTuple());  // Returns [i32, i32]
```

## Comparison with Alternatives

### Option 1: Allocation Sinking (Escape Analysis)

```zena
interface Iterator<T> {
  next(): { done: boolean, value: T };  // Regular record
}

let {done, value} = iter.next();
```

The compiler could detect non-escaping records and replace with locals.

| Aspect                 | Multi-Return        | Allocation Sinking         |
| ---------------------- | ------------------- | -------------------------- |
| Zero-alloc guaranteed? | ✅ Always           | ⚠️ When optimization fires |
| User predictability    | ✅ Clear from types | ❌ Opaque                  |
| Implementation         | Medium              | Complex                    |
| Type syntax            | New `(T, T)` syntax | None                       |

**Verdict:** Multi-return is explicit and guaranteed; allocation sinking is an
optimization that may or may not happen.

### Option 2: Out Parameters

```zena
interface Iterator<T> {
  next(out value: T): boolean;
}

var item: i32;
while (iter.next(out item)) {
  // use item
}
```

| Aspect       | Multi-Return            | Out Parameters               |
| ------------ | ----------------------- | ---------------------------- |
| Ergonomics   | ✅ Single expression    | ⚠️ Requires pre-declared var |
| Mutability   | ✅ Values are immutable | ❌ Requires `var`            |
| WASM mapping | ✅ Direct               | ⚠️ Needs boxing or locals    |

**Verdict:** Out parameters require mutable variables and don't map as cleanly
to WASM.

## Implementation Plan

### Phase 1: Parser & AST

- [ ] Add `UnboxedTupleType` AST node
- [ ] Parse `(T1, T2)` return type syntax
- [ ] Parse `(expr1, expr2)` return expressions
- [ ] Parse `let (a, b) = expr` destructuring

### Phase 2: Type Checker

- [ ] Add `UnboxedTupleType` to type system
- [ ] Validate unboxed tuples only in return position
- [ ] Check destructuring patterns match tuple arity
- [ ] Type inference for tuple elements

### Phase 3: Code Generation

- [ ] Emit multi-value function signatures
- [ ] Generate tuple return expressions
- [ ] Generate destructuring (reverse-order local.set)
- [ ] Update interface vtable types for multi-returns

### Phase 4: Iteration Support

- [ ] Redesign `Iterator<T>` with multi-return `next()`
- [ ] Add `for..of` syntax (parser)
- [ ] Generate for..of with block parameters (codegen)
- [ ] Update stdlib iterators

### Phase 5: Pattern Matching

- [ ] Support unboxed tuple patterns in `match`
- [ ] Support `if (let pattern = expr)`
- [ ] Support `while (let pattern = expr)`

## Open Questions

1. **Named vs positional fields?** Should `(a: i32, b: i32)` be distinct from
   `(i32, i32)`?
   - Proposal: Names are documentation only, structurally equivalent

2. **Maximum arity?** WASM has no limit, but should Zena?
   - Proposal: No artificial limit, but lint for > 4 elements

3. **Syntax for single-element tuples?** `(i32)` is ambiguous with parenthesized
   expressions.
   - Proposal: Single-element tuples are not useful, don't support them

4. **Spread into boxed tuples?** `[getTuple()...]` or `[...getTuple()]`?
   - Proposal: `[...getTuple()]` matches JS spread syntax

5. **Discriminated tuple unions for type safety?**

   Could we use a union type to statically prevent accessing `value` when
   `hasMore` is `false`?

   ```zena
   interface Iterator<T> {
     next(): (true, T) | (false, never);
   }
   ```

   After destructuring:

   ```zena
   let (hasMore, value) = iter.next();
   // Type of value: T | never

   if (hasMore) {
     process(value);  // ✅ value narrowed to T
   } else {
     process(value);  // ❌ Error: cannot use value of type 'never'
   }
   ```

   **Requirements:**
   - Literal types for `true` and `false` (not just `boolean`)
   - Union types on unboxed tuples
   - Control-flow narrowing based on tuple element values

   **WASM representation:** Unchanged - still `(i32, anyref)`. The union is
   purely compile-time.

   **Pattern matching integration:**

   ```zena
   match iter.next() {
     case (true, value) => process(value),  // value: T
     case (false, _) => done(),             // _ is never, can't be bound
   }

   // Or with while-let:
   while (let (true, item) = iter.next()) {
     // Only matches when first element is true
     // item is T, not T | never
   }
   ```

   **Verdict:** This is the ideal solution - full static safety with zero
   runtime cost. Requires literal boolean types and tuple union narrowing.

## References

- [WASM Multi-Value Proposal](https://github.com/WebAssembly/multi-value)
- [WASM Block
  Parameters](https://github.com/WebAssembly/multi-value/blob/master/proposals/multi-value/Overview.md)
- [Rust's tuple returns](https://doc.rust-lang.org/std/primitive.tuple.html)
- [Go's multiple return
  values](https://go.dev/doc/effective_go#multiple-returns)
