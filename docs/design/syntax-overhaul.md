# Syntax Overhaul

**Status: Proposed**
**Date: 2026-02-27**

This document describes a comprehensive set of syntax changes to improve
consistency, familiarity, and ergonomics. These changes touch arrays, tuples,
records, maps, constructors, and symbol-keyed members.

**Guiding Principles**:

1. **`#` means private** — and nothing else.
2. **`[]` means array** — universal expectation.
3. **`()` means tuple** — Rust/Dart/Python precedent.
4. **`{}` means record or block** — context-disambiguated.
5. **Modifiers are prefix keywords** — `exact`, `inline`.
6. **`@` is the macro sigil** — decorators are macros.

## 1. Summary of Changes

| Construct            | Before                | After                       | Rationale                              |
| -------------------- | --------------------- | --------------------------- | -------------------------------------- |
| Array literal        | `#[1, 2, 3]`          | `[1, 2, 3]`                 | Universal expectation                  |
| Array type           | `FixedArray<T>`       | `FixedArray<T>` (unchanged) | Explicit named type                    |
| Boxed tuple literal  | `[1, "hi"]`           | `(1, "hi")`                 | Parens for tuples (Rust/Dart)          |
| Boxed tuple type     | `[i32, string]`       | `(i32, string)`             | Consistent with literal                |
| Inline tuple type    | `(i32, i32)` (ad hoc) | `inline (i32, i32)`         | Explicit modifier                      |
| Record (wide)        | `{x: 1, y: 2}`        | `{x: 1, y: 2}` (unchanged)  | Already good                           |
| Record (exact) type  | TBD                   | `exact {x: i32; y: i32}`    | Prefix keyword, scannable              |
| Inline record type   | N/A                   | `inline {x: i32; y: i32}`   | Named multi-value return, zero alloc   |
| Map literal          | None                  | `{"a" => 1, "b" => 2}`      | `=>` disambiguates from records        |
| Constructor          | `#new(...)`           | `new(...)`                  | Drop confusing `#`; `new` is a keyword |
| Private field        | `#name`               | `#name` (unchanged)         | JS-familiar, works well                |
| Symbol member (def)  | `:Sym.method()`       | `impl Sym.method()`         | Avoid double-colon visual collision    |
| Symbol member (call) | `obj.:Sym.m()`        | `obj.:Sym.m()` (unchanged)  | Compact enough                         |
| Collection macro     | N/A                   | `@Array[1, 2, 3]`           | `@` for macro invocations              |

## 2. Arrays: `[...]`

### 2.1 Rationale

In every major language (JS, TS, Python, Swift, Rust, Dart, Kotlin),
`[1, 2, 3]` means an ordered, indexable, iterable collection. The previous
syntax `#[1, 2, 3]` was noisy, unfamiliar, and LLM-hostile — models
consistently generated `[1, 2, 3]` and had to be corrected.

### 2.2 Design

`[expr, expr, ...]` creates a `FixedArray<T>` — the native WASM GC array type.
This is the most efficient array representation (no wrapper object, direct
`array.new`, `array.get`, `array.set`).

```zena
let nums = [1, 2, 3];           // FixedArray<i32>
let names = ["Alice", "Bob"];    // FixedArray<string>
let empty: FixedArray<i32> = []; // empty array (type annotation required)
```

Growable `Array<T>` is constructed explicitly:

```zena
let grow = Array.from([1, 2, 3]);   // Array<i32> from fixed array
let empty = new Array<i32>();       // Array<i32> with default capacity
```

See Section 9 for macro-based collection literals (`@Array[1, 2, 3]`) that
avoid the copy.

### 2.3 Tuple Destructuring

With `[]` now meaning arrays, **tuple destructuring** changes to use parens:

```zena
// Before (tuple destructuring)
let [a, b] = someTuple;

// After
let (a, b) = someTuple;
```

**Array destructuring** is a separate feature (if needed) and would also use
`[]`, but arrays are mutable-length so positional destructuring is less
natural. We can defer array destructuring.

## 3. Tuples: `(...)`

### 3.1 Boxed Tuples (Heap-Allocated)

Boxed tuples are first-class values that can be stored in variables, passed
around, and put in collections. They compile to WASM GC structs.

**Type syntax**: `(i32, string)`
**Literal syntax**: `(1, "hello")`
**Access syntax**: `t.0`, `t.1` (dot + numeric index)

```zena
let pair: (i32, string) = (42, "hello");
let (id, name) = pair;       // destructure
let stored = pair;            // ✅ can store, first-class value
```

### 3.2 Disambiguating from Grouping

Zena does not have parenthesized grouping expressions `(expr)`. Instead, block
expressions `{ expr }` serve this purpose. This eliminates the ambiguity
between a 1-tuple and a grouped expression.

```zena
// Block expression for grouping (replaces parens-for-grouping)
let x = { a + b } * c;

// Single-element tuple (rare, but unambiguous)
let single: (i32,) = (42,);   // trailing comma required for 1-tuples
```

**Parentheses remain valid in**:

- Function calls: `f(x, y)`
- `if`/`while`/`for` conditions: `if (x > 0) { ... }`
- Type parameters in function types: `(i32, i32) => i32`

These are not expressions — the parser knows from context that `(` after `if`
or a function name is not a tuple.

### 3.3 Inline Tuples (Stack-Only)

Inline tuples use WASM multi-value returns. They cannot be stored — they must
be destructured immediately at the call site. The `inline` modifier makes
this explicit.

**Type syntax**: `inline (i32, i32)`

```zena
let divmod = (a: i32, b: i32): inline (i32, i32) => {
  return (a / b, a % b);
};

let (q, r) = divmod(10, 3);     // ✅ must destructure
// let result = divmod(10, 3);   // ❌ Error: inline tuple must be destructured
```

### 3.4 Boxed vs Inline

| Aspect      | Boxed `(i32, string)`  | Inline `inline (i32, i32)` |
| ----------- | ---------------------- | -------------------------- |
| Allocation  | Heap (WASM GC struct)  | None (stack/registers)     |
| First-class | Yes                    | No — must destructure      |
| Storable    | Yes                    | No                         |
| WASM output | `struct.new`           | Multi-value return         |
| Use case    | Data grouping, storage | Multi-return, iterators    |

### 3.5 Tuple Access Syntax

Boxed tuples use **dot-numeric** access rather than bracket indexing:

```zena
let t = (42, "hello", true);
let first = t.0;     // 42
let second = t.1;    // "hello"
```

This avoids ambiguity with array indexing (`arr[i]` where `i` can be runtime)
and makes clear that tuple access is always compile-time resolved.

## 4. Records

### 4.1 Wide Records (Unchanged)

Wide records use width subtyping and are the default. Syntax is unchanged:

```zena
let p = {x: 10, y: 20};                  // literal
let q: {x: i32; y: i32} = {x: 1, y: 2}; // type annotation
```

### 4.2 Exact Records

Exact records reject width subtyping, reject optional fields, and use direct
`struct.get` — no fat pointer, no vtable dispatch.

**Type syntax**: `exact {x: i32; y: i32}` (prefix keyword)

```zena
let p: exact {x: i32; y: i32} = {x: 1, y: 2};       // ✅
let q: exact {x: i32; y: i32} = {x: 1, y: 2, z: 3}; // ❌ extra field rejected

// Function parameter
let draw = (p: exact {x: i32; y: i32}) => {
  p.x;  // direct struct.get — no dispatch
};
```

**No `exact` on literals**: A record literal always starts as a bare struct
internally. The representation is determined by the type context:

- Exact type context → bare struct (no fat pointer)
- Wide type context → bare struct wrapped in fat pointer at the coercion boundary
- No annotation → infer exact (fast by default)

Widening coercion (exact → wide) happens automatically when passing an exact
record to a wide parameter. Narrowing (wide → exact) is an error.

```zena
let p = {x: 1, y: 2};                   // inferred: exact {x: i32; y: i32}
let draw = (pt: {x: i32; y: i32}) => {};  // wide parameter
draw(p);                                  // ✅ auto-wraps in fat pointer at boundary
```

### 4.3 Inline Records (Named Multi-Value)

Inline records are like inline tuples, but with named fields. They compile to
WASM multi-value returns and must be destructured immediately.

**Type syntax**: `inline {x: i32; y: i32}`

```zena
let getPosition = (): inline {x: i32; y: i32} => {
  return {x: 10, y: 20};
};

let {x, y} = getPosition();     // ✅ named destructure, zero allocation
// let pos = getPosition();      // ❌ Error: inline record must be destructured
```

`inline` implies `exact` — you can't have width subtyping when values are
exploded onto the stack.

**Inline record parameters** enable argument explosion:

```zena
let draw = (opts: inline {x: i32; y: i32; color: string}) => { ... };
draw({x: 10, y: 20, color: "red"});   // zero allocation — args exploded
```

### 4.4 Empty Records vs Empty Blocks

`{}` is ambiguous between an empty record literal and an empty block expression.

**Resolution**: Context-based disambiguation.

```zena
// Statement position → block (executes nothing)
{ }

// Expression position with record type context → empty record
let r: {} = {};

// Expression position without context → empty block (evaluates to void)
let x = {};   // type: void

// Non-empty cases are always unambiguous:
{ x: 1 }      // record literal (has `ident: expr` structure)
{ foo(); }     // block expression (has statements)
```

**Design note**: Empty records are rarely useful in practice. The main concern
is the parser — it must defer the decision until it sees what follows `{`. If
the next token is `}`, it's an empty block. If it's `ident :`, it starts a
record literal. If it's a statement, it's a block.

## 5. Maps: `{key => value}`

### 5.1 Rationale

Maps are common enough to deserve a literal syntax. The `=>` separator cleanly
disambiguates maps from records (which use `:`).

### 5.2 Design

```zena
let scores = {"Alice" => 95, "Bob" => 87};     // Map<string, i32>
let lookup = {1 => "one", 2 => "two"};          // Map<i32, string>

// Multi-line
let config = {
  "host" => "localhost",
  "port" => 8080,
  "debug" => 1,
};
```

**Empty map**: Maps require explicit construction (cannot use `{}`):

```zena
let m = new Map<string, i32>();   // explicit
```

This avoids ambiguity with empty records and empty blocks.

### 5.3 Parsing

The parser sees `{` and looks ahead:

1. `}` → empty block
2. `ident :` → record literal
3. `expr =>` → map literal
4. Otherwise → block expression

The `=>` token after the first expression is the unambiguous signal for a map.

### 5.4 Type Inference

```zena
let m = {"a" => 1, "b" => 2};          // Map<string, i32>
let m: Map<string, i32> = {"a" => 1};  // explicit annotation
```

Key and value types are inferred from the first entry, unified across all
entries. Mismatched types are an error:

```zena
let m = {"a" => 1, 2 => "b"};   // ❌ Error: inconsistent key/value types
```

## 6. Constructors: Drop `#`

### 6.1 Rationale

`#new(...)` used `#` to signal "this is special, not a regular method." But
`#` already means "private" for fields (`#name`). Using it for constructors
too is confusing — it makes people think constructors are private.

### 6.2 Decision: `new(...)`

`new` is already a keyword (used at the call site: `new Foo()`), so it cannot
collide with instance methods. Using it for the constructor definition mirrors
the call site naturally.

```zena
class Rectangle {
  let width: i32;
  let height: i32;
  let area: i32;

  new(w: i32, h: i32) : width = w, height = h, area = w * h { }
}

let r = new Rectangle(10, 20);
```

**Alternatives considered**:

- `init(...)` — Swift precedent, but steals `init` from the instance namespace.
- `constructor(...)` — TS precedent, but verbose.

`new` was chosen because it mirrors the call site, is already reserved, and
does not consume any identifier from the method namespace.

## 7. Symbol-Keyed Members: `impl` in Definitions

### 7.1 Problem

The current `:Symbol.method(): ReturnType` syntax has a visual collision
between the symbol-prefix colon and the return-type colon:

```zena
// Current: the two colons look related
:Iterable.iterator(): Iterator<T> {
```

### 7.2 Design

Use the `impl` keyword in **definitions** for clarity. Keep `.:` at **call
sites** for compactness.

```zena
// Definition — 'impl' keyword, no colon confusion
class MyList<T> implements Iterable<T> {
  impl Iterable.iterator(): Iterator<T> {
    return new ListIterator<T>(this);
  }
}

// Symbol-keyed fields
class MapEntry<K, V> {
  impl mapEntryKey: K;
  impl mapEntryValue: V;
}

// Call site — compact, unchanged
let iter = list.:Iterable.iterator();
let key = entry.:mapEntryKey;
```

**Why `impl`**:

- Reads naturally: "this class _implements_ the `Iterable.iterator` symbol"
- Rust precedent (`impl Trait for Type`)
- No visual collision with any other colon
- Only needed in definitions — call sites stay compact

## 8. Private Fields: `#` Means Private (Only)

After these changes, `#` has exactly one meaning in the language:

| Previous uses           | New state     |
| ----------------------- | ------------- |
| `#field` — private      | **Unchanged** |
| `#new()` — constructor  | → `new()`     |
| `#[1, 2]` — array       | → `[1, 2]`    |
| `#{...}` — map (unused) | → `{k => v}`  |

This makes `#` completely learnable: "hash means private."

## 9. Collection Macro Literals: `@Type[...]`

### 9.1 Problem

`Array.from([1, 2, 3])` requires copying — the FixedArray is allocated, then
its elements are copied into a new growable Array. For custom collection types
(vectors, matrices, sets), there's no literal syntax at all.

### 9.2 Design: `@` as Macro Invocation

Since decorators are macros (see `docs/design/decorators.md` and
`docs/design/macros.md`), the `@` sigil can serve double duty: `@Name` before
a declaration is a decorator, `@Name` before a literal is a collection macro.

```zena
// Growable array — no copy, direct construction
let grow = @Array[1, 2, 3];

// Custom collections
let v = @Vec3[1.0, 2.0, 3.0];
let s = @Set[1, 2, 3];

// Matrix with nested syntax
let m = @Mat[
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
```

**How it works**: The `@Array[1, 2, 3]` macro receives the array literal AST
and generates optimal construction code — e.g., `array.new` with the right
capacity, then `array.set` for each element, wrapped in the `Array<T>` class.
No intermediate FixedArray is created.

### 9.3 Parsing

`@Identifier` followed by `[`, `(`, or `{` is a macro literal invocation:

- `@Array[1, 2, 3]` — macro applied to array literal
- `@Set{1, 2, 3}` — macro applied to... (TBD: braces for sets?)
- `@Mat[(1, 2), (3, 4)]` — macro applied to array of tuples

The identifier resolves to a macro definition that handles the literal.

### 9.4 Why Not `Array![1, 2, 3]`?

The `!` suffix (Rust-style) reads aggressively and is already used for
logical NOT. Using `@` is consistent with Zena's approach of `@` for
compile-time transformation (decorators are also compile-time transforms).

### 9.5 Relationship to Decorators

Both decorators and collection macros are compile-time AST transformations
invoked with `@`. The distinction is positional:

- `@Name declaration` → decorator (transforms a declaration)
- `@Name literal` → collection macro (transforms a literal into construction code)

This unification means one macro system, one sigil, one mental model.

## 10. Modifier Summary

Two prefix keywords modify structural types:

### `exact` — No Width Subtyping

Applies to record **types** only (not tuples — tuples have no subtyping).

- Disables width subtyping
- Disables optional fields
- Uses bare struct (no fat pointer, no vtable)
- Direct `struct.get`/`struct.set`

```zena
type Point = exact {x: i32; y: i32};
```

### `inline` — No Allocation

Applies to record and tuple **types** in function signatures.

- Values live on the stack (WASM multi-value)
- Must be destructured immediately
- Zero allocation
- Implies `exact` for records

```zena
// Inline tuple return (current "unboxed tuple" behavior)
let divmod = (a: i32, b: i32): inline (i32, i32) => {
  return (a / b, a % b);
};

// Inline record return (new — named multi-value)
let getPos = (): inline {x: i32; y: i32} => {
  return {x: 10, y: 20};
};

// Inline record parameter (argument explosion)
let draw = (p: inline {x: i32; y: i32}): void => { ... };
```

### Composition

`inline` implies `exact`. Writing `inline exact {...}` is redundant but valid.

| Modifier  | Subtyping | Allocation | Storable |
| --------- | --------- | ---------- | -------- |
| (default) | Wide      | Heap       | Yes      |
| `exact`   | None      | Heap       | Yes      |
| `inline`  | None      | Stack      | No       |

## 11. Migration Plan

Since Zena has no external users, migration is about updating our own
codebase (tests, stdlib, examples, docs). No backwards compatibility is
needed, but we should stage changes to keep the compiler working throughout.

### Phase 1: Tuple Syntax (Must Come First)

**Impact**: Parser, AST, type system, codegen, all tuple tests.

**Why first**: `[]` is currently used for boxed tuples. We must move tuples to
`()` before `[]` can be repurposed for arrays. Additionally, `(expr, expr)` is
already used for unboxed (inline) tuple returns. We must introduce the `inline`
modifier first so existing unboxed returns can be distinguished from the new
boxed tuple syntax.

**Sub-phases** (order matters):

1. **`inline` modifier**: Add `inline` keyword in type position. Migrate all
   existing unboxed tuple return types to `inline (T, T)`.
2. **Boxed tuple literals**: Add `(expr, expr)` as boxed tuple literal. Now
   unambiguous because unboxed returns are marked `inline`.
3. **Boxed tuple types**: Add `(T, T)` as boxed tuple type syntax.
4. **Migrate boxed tuples from `[]`**: Update destructuring from
   `let [a, b] =` to `let (a, b) =`, access from `t[0]` to `t.0`.
5. **Remove old `[...]` tuple syntax** from parser (frees `[]` for arrays).

### Phase 2: Array Literal Syntax

**Impact**: Parser, codegen, all tests using `#[...]`.

**Prerequisite**: Phase 1 complete (`[]` is now free).

1. Update parser to accept `[...]` as array literal (keep `#[...]` temporarily)
2. Update codegen for new AST
3. Migrate all `#[...]` in stdlib `.zena` files to `[...]`
4. Migrate all test files
5. Remove `#[...]` support from parser

### Phase 3: Constructor Syntax

**Impact**: Parser, AST, all class definitions.

Small, self-contained change — no dependencies on other phases.

1. Add `new(...)` as constructor syntax (keep `#new(...)` temporarily)
2. Migrate all `#new(...)` in stdlib and tests
3. Remove `#new(...)` support

### Phase 4: Symbol Member Syntax

**Impact**: Parser, AST, stdlib.

1. Add `impl Symbol.method()` syntax for definitions
2. Migrate all `:Symbol.method()` in stdlib
3. Remove old `:Symbol.method()` syntax

### Phase 5: Map Literals

**Impact**: Parser, type system, codegen.

1. Add `{expr => expr, ...}` to parser
2. Type-check as `Map<K, V>`
3. Generate `Map` construction code
4. Add tests

### Phase 6: Exact and Inline Records

**Impact**: Parser, type system, codegen.

Entirely new features — no migration needed, just new functionality.

1. Implement `exact` keyword in type position
2. Implement `inline` keyword in type position for records
3. Default inference to exact for record literals
4. Add widening coercion (exact → wide)
5. Add tests for each variant

### Phase 7: Collection Macros (Future)

**Impact**: Macro system (not yet implemented).

1. Implement `@Name[...]` parsing
2. Implement macro expansion for collection literals
3. Implement `@Array` as built-in collection macro

## 12. Full Example

Putting it all together — a small program using the new syntax:

```zena
import { Iterable, Iterator } from 'zena:iterator';

// Exact record type alias
type Point = exact {x: f64; y: f64};

// Function with inline record return (zero allocation)
let midpoint = (a: Point, b: Point): inline {x: f64; y: f64} => {
  return {x: (a.x + b.x) / 2.0, y: (a.y + b.y) / 2.0};
};

// Standard class with new constructor syntax
class Path {
  let points: FixedArray<Point>;

  new(points: FixedArray<Point>) : points = points { }

  // Symbol-keyed member with 'impl'
  impl Iterable.iterator(): Iterator<Point> {
    return new PathIterator(this.points);
  }

  length(): f64 {
    var total = 0.0;
    for (var i = 1; i < this.points.length; i = i + 1) {
      let {x, y} = midpoint(this.points[i - 1], this.points[i]);
      total = total + x + y;  // simplified
    }
    return total;
  }
}

// Array literal creates FixedArray
let points = [
  {x: 0.0, y: 0.0},
  {x: 1.0, y: 1.0},
  {x: 2.0, y: 0.0},
];

let path = new Path(points);

// Map literal with =>
let labels = {0 => "start", 1 => "peak", 2 => "end"};

// Boxed tuple
let bounds: (Point, Point) = (points[0], points[2]);
let (start, finish) = bounds;

// Inline tuple (multi-value return)
let divmod = (a: i32, b: i32): inline (i32, i32) => {
  return (a / b, a % b);
};
let (q, r) = divmod(10, 3);

// Future: collection macro
// let growable = @Array[1, 2, 3];
```
