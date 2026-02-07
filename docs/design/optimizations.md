# Compiler Optimizations

## Overview

This document catalogs Zena's compiler optimizations and discusses the compiler
architecture needed to implement them effectively. It covers:

1. **Implemented optimizations**: DCE, method-level DCE, vtable elimination
2. **Devirtualization**: Converting virtual calls to direct calls
3. **Future optimizations**: Inlining, escape analysis, monomorphization
4. **WASM-specific optimizations**: Stack usage, trampoline elimination
5. **Compiler architecture**: Passes, IR, SSA considerations
6. **External tools**: wasm-opt integration, optimization levels

**Related documents:**

- [dead-code-elimination.md](dead-code-elimination.md) - Full DCE design
- [optimization-strategy.md](optimization-strategy.md) - Phasing philosophy (correctness first, explicit before implicit)

---

## Implemented Optimizations

### Dead Code Elimination ✅

**Full design**: [dead-code-elimination.md](dead-code-elimination.md)

DCE eliminates unreachable code at multiple granularities:

| Level       | What's Eliminated                                        | Status         |
| ----------- | -------------------------------------------------------- | -------------- |
| Declaration | Unused functions, classes, interfaces                    | ✅ Implemented |
| Method      | Methods never called (fully eliminated, no vtable entry) | ✅ Implemented |
| VTable      | Empty vtables for extension classes                      | ✅ Implemented |
| Field       | Write-only fields (limited)                              | 🔲 Partial     |

**Results**: 91% reduction for minimal programs (1957 → 175 bytes).

### Write-Only Field Elimination (Partial) ✅

Currently eliminates fields that are written but never read, but only for simple
cases. Does not handle:

- Fields incremented in loops (`this.count = this.count + 1`)
- Fields used in expressions that are themselves unused

See [Compiler Architecture](#compiler-architecture) for how IR/SSA could improve this.

---

## Devirtualization

Devirtualization converts virtual method calls (via vtables or `call_indirect`)
into direct calls, enabling inlining and other optimizations.

### When Virtual Calls Occur

```zena
abstract class String { ... }
final class GCString extends String { ... }
final class LinearString extends String { ... }

func process(s: String): void {
  s.indexOf("x");  // Virtual call: s could be any String subtype
}
```

### When Devirtualization Applies

1. **Single implementation**: Only one concrete class implements the type
2. **Known concrete type**: Variable was assigned from `new ConcreteClass(...)`
3. **Type narrowing**: Control flow proves the concrete type via `is` check
4. **Concrete return types**: Function analysis shows all returns are same type

---

## Optimization Catalog

### Tier 1: Local Analysis (Easy, Implement First)

#### 1.1 Single Implementation

**When:** An abstract class/interface has only one concrete implementation in the program.

```zena
abstract class String { ... }
final class GCString extends String { ... }
// No other String subclasses exist

let s: String = ...;
s.indexOf("x");  // Devirtualize: only GCString exists
```

**Implementation:** Count implementations during class registration. If count == 1,
all calls can be direct.

**Status:** 🔲 Not implemented

---

#### 1.2 Constructor Return Type

**When:** Variable initialized with `new ConcreteClass(...)`.

```zena
let s: String = new GCString("hello");
s.indexOf("x");  // Devirtualize: s is definitely GCString
```

**Implementation:** If init is `NewExpression` of final class, concrete type = that class.

**Status:** 🔲 Not implemented

---

#### 1.3 Literal Types

**When:** Variable initialized with a literal.

```zena
let s: String = "hello";  // Concrete: LiteralString (or GCString)
s.indexOf("x");           // Devirtualize
```

**Implementation:** String/number/array literals have known concrete types.

**Status:** 🔲 Not implemented

---

#### 1.4 Type Narrowing (is/as)

**When:** Control flow narrows type via `is` check or `as` cast.

```zena
func process(s: String): void {
  if (s is LinearString) {
    s.indexOf("x");  // Devirtualize: narrowed to LinearString
  }
}
```

**Implementation:** Already have narrowing for null checks; extend to class types.

**Status:** 🔲 Not implemented (class narrowing)

---

### Tier 2: Intraprocedural Analysis (Medium)

#### 2.1 Single-Return Function

**When:** Function has exactly one return statement.

```zena
func makeString(): String {
  return new GCString("hello");  // Concrete: GCString
}

let s = makeString();
s.indexOf("x");  // Devirtualize
```

**Implementation:** Check function body for single return, infer concrete type from it.

**Status:** 🔲 Not implemented

---

#### 2.2 All-Same-Type Returns

**When:** Function has multiple returns, all returning same concrete type.

```zena
func choose(b: boolean): String {
  if (b) return new LinearString(ptr1, len1);
  return new LinearString(ptr2, len2);  // Both LinearString
}

let s = choose(true);
s.indexOf("x");  // Devirtualize
```

**Implementation:** Collect all return expressions, check if concrete types match.

**Status:** 🔲 Not implemented

---

#### 2.3 Flow-Sensitive Locals

**When:** Tracking concrete types through local variable assignments.

```zena
var s: String;
s = new GCString("a");
s.indexOf("x");  // Here s is GCString

s = new LinearString(ptr, len);
s.indexOf("y");  // Here s is LinearString
```

**Implementation:** SSA form or reaching definitions to track concrete type at each use.

**Status:** 🔲 Not implemented

---

#### 2.4 Union of Final Types

**When:** Merge point has multiple concrete types, but all are final.

```zena
let s: String = cond ? new GCString("a") : new LinearString(p, n);
// Concrete: GCString | LinearString

s.indexOf("x");  // Emit type switch instead of vtable call
```

**Generated code:**

```wat
if (s is GCString) {
  call $GCString_indexOf
} else {
  call $LinearString_indexOf
}
```

**Implementation:** Track union of concrete types; emit type switch for small unions (≤4).

**Status:** 🔲 Not implemented

---

### Tier 3: Interprocedural Analysis (Hard)

#### 3.1 Field Type Narrowing

**When:** All writes to a field use the same concrete type.

```zena
class Config {
  data: String;

  #new(path: String) {
    this.data = File.read(path);  // LinearString
  }

  reload(): void {
    this.data = File.read(this.path);  // LinearString
  }
}

// All writes to `data` are LinearString
config.data.indexOf("x");  // Devirtualize!
```

**Implementation:**

1. Collect all assignment sites to each field
2. Compute concrete type at each site
3. If all same → field has narrowed concrete type
4. Propagate to field reads

**Challenges:**

- Must analyze all classes that could write to field (subclasses)
- Reflective/dynamic writes break analysis
- Need whole-program pass

**Status:** 🔲 Not implemented

---

#### 3.2 Callback Type Narrowing

**When:** All call sites pass same concrete callback type.

```zena
func map(arr: Array<String>, f: (String) => String): Array<String> {
  // f could be any function... or could it?
}

// Call sites:
map(arr1, (s) => s.toUpperCase());  // Closure type A
map(arr2, (s) => s.toLowerCase());  // Closure type A (same signature/capture)

// If all calls pass same closure "shape", can we devirtualize f() inside map?
```

**Implementation:**

1. Track all call sites of higher-order function
2. Analyze concrete type of callback argument at each site
3. If monomorphic → specialize function for that callback type

**Challenges:**

- Closures with different captures are different types
- May need to clone/specialize the function
- Exponential blowup with multiple HOF parameters

**Status:** 🔲 Not implemented

---

#### 3.3 Container Element Type Narrowing

**When:** All elements added to a container have same concrete type.

```zena
let strings: Array<String> = #[];
strings.push(new GCString("a"));
strings.push(new GCString("b"));
// All elements are GCString

for (let s in strings) {
  s.indexOf("x");  // Devirtualize!
}
```

**Implementation:**

1. Track all `push`/`set`/`add` operations on container
2. Compute concrete element type
3. Propagate to iteration/access sites

**Challenges:**

- Must track container identity through aliases
- Cross-function analysis needed
- Containers passed to unknown functions lose precision

**Status:** 🔲 Not implemented

---

#### 3.4 Call Graph-Based Propagation

**When:** Concrete types flow through call chains.

```zena
func readAll(): String {
  return File.read("data.txt");  // LinearString
}

func process(): String {
  return readAll();  // Propagate: also LinearString
}

func main(): void {
  let s = process();
  s.indexOf("x");  // Devirtualize via transitive analysis
}
```

**Implementation:**

1. Build call graph
2. Propagate concrete return types bottom-up
3. Re-analyze callers when callee types are refined
4. Fixed-point iteration

**Status:** 🔲 Not implemented

---

### Tier 4: Speculative/Profile-Guided (Future)

#### 4.1 Profile-Guided Devirtualization

**When:** Runtime profiling shows a call site is monomorphic.

```zena
func process(s: String): void {
  s.indexOf("x");  // Statically polymorphic, but profile shows 99% GCString
}
```

**Generated code:**

```wat
;; Speculative devirtualization with guard
if (s.typeTag == $GCString) {
  call $GCString_indexOf  ;; Fast path
} else {
  call_indirect ...       ;; Slow path (deoptimize)
}
```

**Implementation:**

1. Instrument builds to collect type profiles
2. Read profiles during optimized compilation
3. Emit guarded direct calls for hot monomorphic sites

**Status:** 🔲 Not implemented

---

#### 4.2 Inline Caching Stubs

**When:** Emitting our own IC mechanism for polymorphic sites.

Instead of relying on JIT, emit explicit type caches:

```zena
// First call: cache miss, do lookup, cache result
// Subsequent: check cache, direct call if hit
```

**Trade-off:** Code size vs. helping less-sophisticated JITs (wasmtime).

**Status:** 🔲 Not implemented

---

## Implementation Priority

| Priority | Optimization               | Impact | Effort    |
| -------- | -------------------------- | ------ | --------- |
| **P0**   | 1.1 Single Implementation  | High   | Low       |
| **P0**   | 1.2 Constructor Return     | High   | Low       |
| **P0**   | 1.3 Literal Types          | Medium | Low       |
| **P1**   | 1.4 Type Narrowing (is)    | Medium | Medium    |
| **P1**   | 2.1 Single-Return Function | High   | Low       |
| **P1**   | 2.2 All-Same Returns       | High   | Medium    |
| **P2**   | 2.3 Flow-Sensitive Locals  | Medium | High      |
| **P2**   | 2.4 Union Type Switch      | Medium | Medium    |
| **P2**   | 3.1 Field Type Narrowing   | High   | High      |
| **P3**   | 3.2 Callback Narrowing     | Medium | Very High |
| **P3**   | 3.3 Container Elements     | Medium | Very High |
| **P3**   | 3.4 Call Graph Propagation | High   | High      |
| **P4**   | 4.1 Profile-Guided         | High   | Very High |

---

## Tracking

- [ ] **P0: Core devirtualization** (Tier 1)
  - [ ] 1.1 Single implementation detection
  - [ ] 1.2 Constructor return type
  - [ ] 1.3 Literal concrete types
- [ ] **P1: Function-level inference** (Tier 2a)
  - [ ] 1.4 Type narrowing via `is`
  - [ ] 2.1 Single-return functions
  - [ ] 2.2 All-same-type returns
- [ ] **P2: Advanced local analysis** (Tier 2b)
  - [ ] 2.3 Flow-sensitive locals
  - [ ] 2.4 Union type switches
  - [ ] 3.1 Field type narrowing
- [ ] **P3: Whole-program analysis** (Tier 3)
  - [ ] 3.2 Callback narrowing
  - [ ] 3.3 Container element narrowing
  - [ ] 3.4 Call graph propagation
- [ ] **P4: Speculative** (Tier 4)
  - [ ] 4.1 Profile-guided optimization
  - [ ] 4.2 Inline caching stubs

---

## JIT Devirtualization

When compile-time devirtualization isn't possible, WASM JITs can optimize at runtime.

### WASM Runtimes and JIT Capabilities

| Runtime                | JIT?   | Optimizer          | Notes              |
| ---------------------- | ------ | ------------------ | ------------------ |
| V8 (Chrome/Node)       | Yes    | Liftoff + TurboFan | Very sophisticated |
| SpiderMonkey (Firefox) | Yes    | Baseline + Ion     | Good optimizations |
| wasmtime               | Yes    | Cranelift          | Improving rapidly  |
| wasm2c / WAMR          | No/AOT | Varies             | Less optimization  |

### How JIT Inline Caching Works

JITs track which types flow through each call site:

1. **Monomorphic** (same type always): Type guard + direct call (~1-3 cycles overhead)
2. **Polymorphic** (2-4 types): Chain of type checks (~5-10 cycles)
3. **Megamorphic** (many types): Full indirect call (~15-25 cycles)

### Design Implications

1. **Trust the JIT for monomorphic sites**: Most call sites only see one type
   at runtime, even if the static type is abstract.

2. **Design APIs to encourage monomorphism**:

   ```zena
   // Good: File API returns LinearString, keeps sites monomorphic
   func readFile(path: String): LinearString { ... }

   // Less ideal: Returns abstract type
   func readFile(path: String): String { ... }
   ```

3. **Compile-time devirtualization helps all runtimes**: Less sophisticated
   JITs (wasmtime) benefit more from our AOT optimizations.

---

## Concrete Return Type Inference

### Approach

Track the actual returned type, not just the declared type:

```zena
func readConfig(): String {    // Declared: String
  return File.read("config");  // Actual: LinearString
}

// During checking, we can compute:
//   declaredReturnType: String
//   concreteReturnType: LinearString (from analyzing all return statements)
```

### Implementation

```typescript
// In FunctionType, add:
interface FunctionType {
  returnType: Type; // Declared return type
  concreteReturnType?: Type; // Inferred concrete type (if narrower)
}

// During function checking:
function checkFunctionBody(func: FunctionDeclaration, ctx: CheckerContext) {
  const returnStatements = collectReturnStatements(func.body);
  const returnTypes = returnStatements.map((r) => r.value.inferredType);

  // Compute the "concrete return type" - the most specific common type
  const concreteType = computeConcreteType(returnTypes);

  // If it's narrower than declared, record it
  if (isSubtype(concreteType, func.declaredReturnType)) {
    func.type.concreteReturnType = concreteType;
  }
}
```

### Propagating Concrete Types

Once we have concrete return types, propagate them to call sites:

```zena
let s = makeString();  // Type: String, ConcreteType: GCString
s.indexOf("x");        // Codegen sees concreteType is GCString → devirtualize
```

### Caveats

1. **Fields**: Can hold any subtype, need whole-program analysis to narrow
2. **Recursive functions**: Concrete type depends on call site
3. **Higher-order functions**: Callback's concrete type depends on caller

---

## Other Optimizations

### Inlining

**Status:** 🔲 Not implemented

Inline small functions at call sites to eliminate call overhead and enable
further optimizations (constant propagation, dead code elimination within the
inlined body).

**Candidates for inlining:**

- Small functions (< N instructions)
- Functions called from a single site
- Devirtualized method calls
- Getters/setters (trivial accessors)
- **Higher-order functions** (`map`, `filter`, `forEach`, `fold`)

#### Higher-Order Function Inlining

HOFs are prime inlining candidates because inlining enables a cascade of optimizations:

```zena
// Original
let doubled = arr.map((x) => x * 2);

// After inlining map():
let doubled = #[];
for (let i = 0; i < arr.length; i = i + 1) {
  doubled.push(closure(arr[i]));  // closure = (x) => x * 2
}

// After closure inlining (closure is now known):
let doubled = #[];
for (let i = 0; i < arr.length; i = i + 1) {
  doubled.push(arr[i] * 2);  // No closure call!
}

// After escape analysis (closure never escapes):
// Closure allocation eliminated entirely
```

**Optimization cascade:**

1. **Inline HOF**: Loop body becomes visible
2. **Devirtualize closure**: Concrete closure type is known at call site
3. **Inline closure body**: Eliminate indirect call overhead
4. **Escape analysis**: Closure doesn't escape → no allocation needed
5. **Scalar replacement**: If closure captured variables, replace with locals

**Result:** What started as `arr.map(f)` becomes a simple loop with no allocations.

#### HOF Inlining Heuristics

Start conservatively with heuristics that cover common stdlib patterns (`map`, `filter`, `reduce`):

**When to inline a HOF call:**

1. **Closure argument is a literal**: `arr.map((x) => x * 2)` ✅
2. **Closure is a local used only here**:
   ```zena
   let double = (x: i32) => x * 2;
   arr.map(double);  // ✅ double is only passed to this one call
   ```
3. **AND** the HOF body is small (< 20 instructions, single loop)

**When NOT to inline:**

```zena
// ❌ Closure escapes or is used multiple times
let double = (x: i32) => x * 2;
arr1.map(double);
arr2.map(double);  // double used twice - don't inline either

// ❌ Closure comes from parameter or field
func process(arr: Array<i32>, f: (i32) => i32): Array<i32> {
  return arr.map(f);  // f could be anything - don't inline
}

// ❌ HOF body is complex (recursive, multiple loops, etc.)
```

**Why these heuristics work for stdlib:**

- `map`, `filter`, `reduce`, `find` have simple loop bodies (~10-15 instructions)
- Most real usage passes literal closures: `arr.map((x) => x.name)`
- Single-use locals are the next most common pattern
- These cover 90%+ of HOF usage while avoiding code bloat

**`forEach` consideration:** We could add `forEach`, but idiomatic Zena uses
`for-in` loops which already compile to efficient code. `forEach` would mainly
benefit code ported from JS. If added, it should inline to a plain loop.

**Challenges:**

- Code size increase (need heuristics)
- Recursive functions can't be fully inlined
- Need call graph to avoid infinite inlining

**Interaction with devirtualization:** Devirtualization enables inlining (can't
inline virtual calls). Inlining enables further devirtualization (inlined code
may have concrete types).

#### Iterative Optimization

Devirtualization and inlining have a cyclic dependency:

```zena
func getProcessor(): Processor {
  return new FastProcessor();  // Concrete: FastProcessor
}

func run(p: Processor): i32 {
  return p.process();  // Virtual call (p's type is abstract)
}

func main(): i32 {
  return run(getProcessor());
}
```

**Single pass:**

1. Devirtualize: Can't devirtualize `p.process()` (p is abstract `Processor`)
2. Inline: Can inline `run()` into `main()`, can inline `getProcessor()`

**After inlining `run(getProcessor())` into main:**

```zena
func main(): i32 {
  let p = new FastProcessor();  // Now concrete type is visible!
  return p.process();           // Can devirtualize!
}
```

**Second devirtualization pass:** Now `p.process()` can be devirtualized.

**Options:**

1. **Fixed-point iteration**: Run devirt → inline → devirt → inline until no changes
   - Guaranteed to converge (finite program)
   - May be slow for deep call chains
2. **Combined pass**: Interleave devirt and inline decisions in one traversal
   - More complex implementation
   - Potentially faster

3. **Limited iterations**: Run 2-3 iterations, accept diminishing returns
   - Pragmatic compromise
   - Covers most real cases

**Recommendation:** Start with 2 iterations (devirt → inline → devirt → inline).
Most benefit comes from the first round; deep chains are rare in practice.

---

### Escape Analysis

**Status:** 🔲 Not implemented

Determine if an object "escapes" its allocation context. Non-escaping objects can be
**scalar replaced**: replace the object with individual local variables, eliminating
the allocation entirely.

> **WASM GC note:** Unlike native compilers, WASM GC doesn't support stack allocation.
> All `struct.new` operations allocate on the GC heap. The only way to avoid allocation
> is scalar replacement - eliminating the object entirely by promoting fields to locals.

```zena
func distance(x1: i32, y1: i32, x2: i32, y2: i32): f64 {
  let p1 = {x: x1, y: y1};  // Record doesn't escape
  let p2 = {x: x2, y: y2};  // Record doesn't escape
  let dx = p2.x - p1.x;
  let dy = p2.y - p1.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// With escape analysis + scalar replacement:
func distance(x1: i32, y1: i32, x2: i32, y2: i32): f64 {
  // p1 and p2 are replaced with their fields directly (no allocation!)
  let dx = x2 - x1;
  let dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}
```

**Escape conditions:**

- Stored to heap (field, array element, global)
- Passed to function that might store it
- Returned from function
- Thrown as exception

**Benefits:**

- Reduces GC pressure
- Enables further optimizations on scalar values
- Critical for iterator performance (avoid allocating iterator objects)
- **Enables HOF optimization**: Closures passed to `map`/`filter` don't escape
  when the HOF is inlined, allowing closure elimination

**Implementation:** Requires dataflow analysis, ideally on SSA form.

---

### Monomorphization

**Status:** ✅ Implemented (full monomorphization)

Zena uses **full monomorphization** for generics: each instantiation like `Box<i32>`
and `Box<String>` gets its own WASM struct type and methods. This is required for:

1. **`is` checks**: `x is Box<i32>` uses WASM's native `ref.test` instruction,
   which requires distinct struct types per instantiation
2. **Zero-cost abstractions**: No boxing overhead for primitives in generic containers
3. **Type safety**: Distinct types can't be confused at runtime

```zena
class Box<T> {
  value: T;
  get(): T { return this.value; }
}

// Monomorphization generates:
// $Box_i32 struct type, $Box_i32_get function
// $Box_String struct type, $Box_String_get function
```

**Trade-offs (for reference):**

| Aspect        | Full Monomorphization | Hybrid                    | Full Erasure      |
| ------------- | --------------------- | ------------------------- | ----------------- |
| Binary size   | Largest               | Medium                    | Smallest          |
| Runtime speed | Best (no boxing)      | Good (primitives unboxed) | Slow (all boxed)  |
| `is` checks   | O(1) `ref.test`       | Tag check for refs        | Tag check for all |
| Compile time  | Slower                | Medium                    | Faster            |

> **Note:** Full erasure is shown for comparison only. Zena will never use full erasure
> because boxing primitives in generic containers (`Box<i32>` allocating a heap object
> for the `i32`) is unacceptable for performance.

**Planned optimization - Hybrid Monomorphization:**

Binary size is critical for Zena because programs are typically:

- Transferred over the network (web apps, edge workers)
- Loaded from storage for cloud functions (cold start latency)
- Embedded in larger applications

We plan to implement **hybrid monomorphization**: full monomorphization for primitives,
shared WASM representation for reference types. This will be controlled by a compiler flag:

```bash
zena build main.zena                    # Default: full monomorphization
zena build main.zena --mono=full        # Explicit: full monomorphization
zena build main.zena --mono=hybrid      # Hybrid: primitives full, refs shared
```

**Full monomorphization (default, `--mono=full`):**

```zena
Box<i32>      // $Box_i32 struct
Box<f64>      // $Box_f64 struct
Box<String>   // $Box_String struct
Box<Widget>   // $Box_Widget struct
```

All `is` checks compile to fast `ref.test` instructions.

**Hybrid monomorphization (`--mono=hybrid`):**

```zena
// Primitives: FULLY MONOMORPHIZED (different WASM struct types)
Box<i32>      // $Box_i32 struct, $Box_i32_get function
Box<f64>      // $Box_f64 struct, $Box_f64_get function

// Reference types: SHARED WASM REPRESENTATION
Box<String>   // $Box_ref struct (value: ref null any, typeTag: i32)
Box<Widget>   // $Box_ref struct (same!)
Box<Foo>      // $Box_ref struct (same!)
```

**Key invariant:** `Box<Foo>` and `Box<Bar>` remain **distinct Zena types** even when
they share the same WASM struct. The Zena type system enforces this at compile time:

```zena
let boxFoo: Box<Foo> = new Box(new Foo());
let boxBar: Box<Bar> = boxFoo;  // ❌ Type error! Different Zena types

let foo: Foo = boxFoo.get();    // ✅ Returns Foo (cast at get site)
let bar: Bar = boxFoo.get();    // ❌ Type error!
```

**`is` check compilation:**

The compiler generates `is` checks based on what's statically known:

```zena
// Case 1: Different WASM representations (always optimizable)
let x: Box<i32> | Box<String> = ...;
if (x is Box<i32>) { ... }
// Compiles to: ref.test $Box_i32 (fast, O(1))

// Case 2: Same WASM representation (hybrid mode only)
let x: Box<Foo> | Box<Bar> = ...;
if (x is Box<Foo>) { ... }
// Compiles to: struct.get $typeTag, i32.eq $Foo_tag (still O(1), but slower)

// Case 3: Full mode - always ref.test
// With --mono=full, case 2 also compiles to ref.test
```

**Implementation approach:**

1. Primitives (`i32`, `i64`, `f32`, `f64`, `boolean`): Always full monomorphization
2. Reference types in hybrid mode: Share WASM struct, add `typeTag` field
3. `is` checks: Emit `ref.test` when representations differ, `typeTag` check otherwise
4. Optimization: In full mode, all `is` checks use `ref.test`

See [generic-specialization-strategy.md](generic-specialization-strategy.md) for details.

---

### Constant Folding & Propagation

**Status:** 🔲 Not implemented

Evaluate constant expressions at compile time:

```zena
let x = 2 + 3;        // → let x = 5;
let y = x * 2;        // → let y = 10;
let s = "hello" + " world";  // → let s = "hello world";
```

**Scope:**

- Arithmetic on literals
- String concatenation of literals
- Boolean logic simplification
- Compile-time-known conditionals (`if (true)` → always taken)

**WASM note:** WASM engines do constant folding, but doing it ourselves:

- Reduces binary size (fewer instructions)
- Enables further optimizations (dead branch elimination)

---

### Loop Optimizations

**Status:** 🔲 Not implemented

#### Loop-Invariant Code Motion (LICM)

Move computations that don't change inside a loop to before the loop:

```zena
// Before
for (var i = 0; i < arr.length; i = i + 1) {
  process(arr[i], config.factor);  // config.factor is loop-invariant
}

// After
let factor = config.factor;
let len = arr.length;
for (var i = 0; i < len; i = i + 1) {
  process(arr[i], factor);
}
```

#### Strength Reduction

Replace expensive operations with cheaper equivalents:

```zena
// Before: multiplication in loop
for (var i = 0; i < n; i = i + 1) {
  arr[i * 4] = 0;
}

// After: addition instead
var offset = 0;
for (var i = 0; i < n; i = i + 1) {
  arr[offset] = 0;
  offset = offset + 4;
}
```

---

## WASM-Specific Optimizations

### Trampoline Elimination

**Status:** 🔲 Not implemented

Zena generates trampolines for:

1. **Argument adaptation**: When passing a function with fewer params than expected
2. **Interface dispatch**: Fat pointer unpacking and vtable lookup
3. **Closure calls**: Loading captured variables from context struct

**Optimization opportunities:**

#### Inline Argument Adaptation

```zena
let f: (i32, i32) => i32 = (a) => a;  // f ignores second param

// Current: trampoline that drops second param
// Optimized: at call sites where we know the adaptation, inline it
```

#### Direct Interface Dispatch

When the concrete type implementing an interface is known:

```zena
func process(seq: Sequence<i32>): void {
  for (let x in seq) { ... }
}

// If seq is always FixedArray<i32>, avoid fat pointer indirection
```

#### Closure Inlining

For non-escaping closures, inline the closure body and eliminate the context struct:

```zena
let multiplier = 2;
let doubled = arr.map((x) => x * multiplier);

// If the closure doesn't escape, inline map's loop and the closure body
```

---

### Stack vs. Local Allocation

**Status:** 🔲 Research needed

WASM has both:

- **Locals**: Named slots in the function's local frame
- **Stack**: Implicit operand stack (values pushed/popped by instructions)

WASM doesn't have explicit "stack allocation" like C. However, there are patterns:

#### Block Parameters (Multi-value)

WASM multi-value allows blocks to take parameters:

```wat
(block $b (param i32) (result i32)
  ;; value on stack becomes block parameter
  i32.const 1
  i32.add
)
```

This could reduce local variable usage for intermediate values, but:

- Most engines optimize locals well anyway
- Block params add complexity
- Benefit is unclear

**Recommendation:** Not a priority. Focus on higher-impact optimizations.

#### Linear Memory Stack

For large structs that don't fit in locals, we could use a shadow stack in
linear memory. This is relevant for FFI interop (see [linear-memory.md](linear-memory.md)).

---

### Instruction Selection

**Status:** 🔲 Not implemented

Choose optimal WASM instructions for patterns:

```zena
// Zena
x = x + 1;

// Naive
local.get $x
i32.const 1
i32.add
local.set $x

// With tee
local.get $x
i32.const 1
i32.add
local.tee $x  // Set and leave on stack (if result is used)
```

Other patterns:

- `select` instead of `if` for simple conditionals
- `br_table` for dense switches (already used for match)
- Combined load+extend or truncate+store

---

## Compiler Architecture

### Current Architecture

```
Source → Lexer → Parser → AST → Checker → Codegen → WASM Binary
                           ↓
                    SemanticContext
                    (bindings, types)
```

**Characteristics:**

- **Single-pass codegen**: AST directly to WASM, no intermediate representation
- **No SSA form**: Variables are mutable, no phi nodes
- **Limited analysis**: Usage analysis for DCE, capture analysis for closures
- **Interleaved concerns**: Type checking and some lowering happen together

### Potential Improvements

#### Intermediate Representation (IR)

An IR between AST and WASM would enable:

1. **Optimization passes**: Transform IR → IR
2. **Multiple backends**: IR → WASM, IR → native (future)
3. **Cleaner separation**: Each pass does one thing

```
AST → Checker → HIR → [Optimize] → LIR → [Optimize] → WASM
                  ↑                   ↑
            High-level IR        Low-level IR
            (close to Zena)      (close to WASM)
```

**HIR (High-Level IR):**

- Preserves Zena semantics (classes, interfaces, closures)
- Target for high-level optimizations (devirtualization, inlining)
- Still has structured control flow

**LIR (Low-Level IR):**

- Flat representation (basic blocks, gotos)
- Target for low-level optimizations (register allocation, instruction selection)
- Close to WASM structure

#### SSA Form

**Static Single Assignment**: Each variable is assigned exactly once.

```zena
// Zena source
var x = 1;
if (cond) {
  x = 2;
}
use(x);

// SSA form
x1 = 1
if (cond) {
  x2 = 2
}
x3 = φ(x1, x2)  // "phi" selects based on control flow
use(x3)
```

**Benefits:**

- Simplifies dataflow analysis (def-use chains are explicit)
- Enables optimizations:
  - Constant propagation
  - Dead store elimination (including write-only fields!)
  - Common subexpression elimination
  - Partial redundancy elimination
- Standard form understood by optimization literature

**Write-only field elimination with SSA:**

```zena
class Counter {
  count: i32 = 0;

  increment(): void {
    this.count = this.count + 1;  // Currently not eliminated
  }
}
```

With SSA + dead store analysis:

1. Convert to SSA: `this.count_2 = this.count_1 + 1`
2. Track that `count` is never read outside the class
3. Eliminate the store (it's dead)

**Cost:**

- Conversion to/from SSA adds compile time
- More complex implementation
- May not be worth it if we rely on wasm-opt

#### Pass Architecture

A formal pass manager would:

1. **Define pass interface**: `Pass.run(ir: IR): IR`
2. **Declare dependencies**: "Inlining requires call graph"
3. **Invalidation**: "Inlining invalidates dominator tree"
4. **Scheduling**: Run passes in optimal order

**Example pass pipeline:**

```
HIR Passes:
  1. Type check (produces typed HIR)
  2. Devirtualization
  3. Inlining (small functions, devirtualized calls)
  4. Escape analysis
  5. Scalar replacement

LIR Passes:
  1. Lower to LIR (flatten control flow)
  2. Dead code elimination
  3. Constant folding
  4. Common subexpression elimination
  5. Instruction selection
  6. Register allocation (locals assignment)

WASM Emission:
  1. Emit WASM binary
```

### Recommendation

**Short term:** Continue with direct AST → WASM, use wasm-opt for optimization.

**Medium term:** Add HIR for high-level optimizations (devirtualization, inlining).

**Long term:** Consider SSA form if we need advanced dataflow optimizations.

The question is: **how much optimization should the Zena compiler do vs. wasm-opt?**

---

## External Tools: wasm-opt

[Binaryen's wasm-opt](https://github.com/WebAssembly/binaryen) is a WASM
optimizer that can be run on our output.

### What wasm-opt Does Well

- **Local optimizations**: Constant folding, dead code, local coalescing
- **Control flow**: Simplify branches, merge blocks, remove unreachable
- **Code size**: Minification, duplicate function merging
- **WASM-specific**: Instruction patterns, stack optimization

### What wasm-opt Can't Do

- **Semantic optimizations**: Devirtualization (doesn't know our vtable layout)
- **Language-level opts**: Escape analysis (doesn't know object lifetimes)
- **Type-directed opts**: Monomorphization (generics already erased)
- **Cross-function**: Limited interprocedural analysis

### Recommended Division

| Optimization           | Zena Compiler | wasm-opt |
| ---------------------- | ------------- | -------- |
| DCE (declarations)     | ✅            | -        |
| DCE (instructions)     | -             | ✅       |
| Devirtualization       | ✅            | -        |
| Inlining (semantic)    | ✅            | -        |
| Inlining (mechanical)  | -             | ✅       |
| Escape analysis        | ✅            | -        |
| Constant folding       | Optional      | ✅       |
| Instruction selection  | -             | ✅       |
| Code size minification | -             | ✅       |

**Strategy:** Focus Zena's optimizer on semantic, type-directed optimizations.
Let wasm-opt handle low-level WASM optimization.

---

## Optimization Levels

### Proposed Flags

```bash
zena build main.zena              # Default: -O1
zena build main.zena -O0          # Debug: no optimization
zena build main.zena -O1          # Default: DCE + basic opts
zena build main.zena -O2          # Aggressive: + devirt + inlining
zena build main.zena -O3          # Maximum: + monomorphization
zena build main.zena -Os          # Size: optimize for binary size
zena build main.zena -Oz          # Min size: aggressive size reduction
```

### What Each Level Does

| Level | DCE | Devirt | Inline  | Mono | wasm-opt | Debug Info |
| ----- | --- | ------ | ------- | ---- | -------- | ---------- |
| -O0   | ❌  | ❌     | ❌      | ❌   | ❌       | ✅ Full    |
| -O1   | ✅  | ❌     | ❌      | ❌   | -O1      | ✅ Basic   |
| -O2   | ✅  | ✅     | ✅      | ❌   | -O2      | ❌         |
| -O3   | ✅  | ✅     | ✅      | ✅   | -O3      | ❌         |
| -Os   | ✅  | ✅     | Limited | ❌   | -Os      | ❌         |
| -Oz   | ✅  | ✅     | ❌      | ❌   | -Oz      | ❌         |

### Debug Builds

```bash
zena build main.zena --debug      # -O0 + DWARF debug info
zena build main.zena -g           # Keep debug info at current opt level
```

**Debug features:**

- Source maps / DWARF for debugger integration
- Bounds checking on array access
- Null pointer checks
- Assertion support (`assert(cond, message)`)
- Runtime type checks (for `as` casts)

**Release features:**

- Elide bounds checks (with `--unsafe` flag)
- Elide null checks where proven safe
- Elide assertions

---

## Tracking

### Implemented

- [x] **Declaration-level DCE** - Skip codegen for unused declarations
- [x] **Method-level DCE** - Fully eliminate unused methods (no vtable entry)
- [x] **VTable elimination** - Skip empty vtables for extension classes
- [x] **Write-only field elimination** (partial, simple cases only)
- [x] **Monomorphization** - Each generic instantiation gets separate WASM types

### P0: Core Devirtualization

- [ ] 1.1 Single implementation detection
- [ ] 1.2 Constructor return type
- [ ] 1.3 Literal concrete types

### P1: Function-Level Inference

- [ ] 1.4 Type narrowing via `is`
- [ ] 2.1 Single-return functions
- [ ] 2.2 All-same-type returns

### P2: Advanced Optimizations

- [ ] 2.3 Flow-sensitive concrete types
- [ ] 2.4 Union type switches
- [ ] 3.1 Field type narrowing
- [ ] Inlining (small functions, accessors)
- [ ] Constant folding

### P3: Major Features

- [ ] 3.2 Callback narrowing
- [ ] 3.3 Container element narrowing
- [ ] 3.4 Call graph propagation
- [ ] Escape analysis
- [ ] Trampoline elimination

### P4: Architecture

- [ ] wasm-opt integration
- [ ] Optimization level flags (-O0, -O1, -O2, -O3)
- [ ] Debug build support
- [ ] HIR intermediate representation (if needed)

### Deferred

- [ ] Hybrid monomorphization (primitives full, references shared) - binary size optimization
- [ ] SSA form (only if needed for specific optimizations)
- [ ] Profile-guided optimization
- [ ] Inline caching stubs
