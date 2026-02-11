# Standard Library & Module System Design

## Overview

The Zena Standard Library (stdlib) should be implemented primarily in Zena
itself ("self-hosted"). This ensures that the language is capable enough to
build complex data structures and allows for better optimization.

This document outlines the **MVP Standard Library** design, focusing on what's
needed for early realistic programs such as parsers, data processors, and simple
applications.

## Design Principles

1.  **Self-Hosting**: Implement core types (`Map`, `Array`, `String`, etc.) in Zena.
2.  **Zero-Overhead Inclusion**: The compiler must perform **Dead Code Elimination (DCE)**. Code from the stdlib (especially the implicitly imported classes) should only be emitted into the final WASM binary if it is actually used. This allows us to hang many utility methods on `String` or `Array` without bloating the binary size of simple programs.
3.  **Implicit Availability**: Core stdlib types (`String`, `Array`, `Map`) must be available in the global scope without explicit `import` statements, as they back language literals.
4.  **Compiler Intrinsics**: Some methods on core classes (e.g., `Array.length`, `String.concat`) cannot be implemented purely in Zena or require direct mapping to WASM instructions. We need a mechanism to mark these methods as intrinsics.
5.  **Dart-Inspired Design**: Dart has a well-designed standard library. We take inspiration from its clear separation of interfaces and implementations.
6.  **Simplicity First**: Start with simple APIs that can be expanded later. Avoid over-engineering.

---

## MVP Standard Library Roadmap

The MVP is organized into four phases, each building on the previous:

### Phase 1: Foundation (Core Primitives)

Types that have special compiler support and back language literals. These are
essential for any Zena program.

| Type            | Description                        | Priority          |
| --------------- | ---------------------------------- | ----------------- |
| `String`        | Immutable UTF-8 string             | ✅ Done           |
| `ByteArray`     | Mutable byte array (backs strings) | ✅ Done           |
| `FixedArray<T>` | Fixed-length WASM GC array         | 🔄 Rename pending |
| `boolean`       | Boolean primitive                  | ✅ Done           |
| `i32`           | 32-bit signed integer              | ✅ Done           |
| `f32`           | 32-bit float                       | ✅ Done           |
| `void`          | Unit type                          | ✅ Done           |
| `Console`       | Basic I/O via host interop         | ✅ Done           |

### Phase 2: Collections (Essential Data Structures)

Types needed for building real programs. A parser, for example, needs growable
lists and key-value storage.

| Type               | Description                              | Priority |
| ------------------ | ---------------------------------------- | -------- |
| `Sequence<T>`      | Read-only indexed collection (interface) | High     |
| `Array<T>`         | Growable array (interface/class)         | High     |
| `ReadonlyArray<T>` | Immutable fixed-length array             | Medium   |
| `Map<K, V>`        | Key-value store (interface or class)     | High     |
| `HashMap<K,V>`     | Hash-based Map implementation            | High     |
| `Set<T>`           | Unique collection (interface or class)   | Medium   |
| `HashSet<T>`       | Hash-based Set implementation            | Medium   |
| `Option<T>`        | Optional value wrapper (Some/None)       | Medium   |
| `Result<T,E>`      | Success/Error wrapper                    | Medium   |

**Design Decision: Interface vs Class**

For `Map` and `Set`, we follow Dart's pragmatic approach:

- `Map<K, V>` and `Set<T>` can be **abstract classes** with factory constructors that return the default hash-based implementation.
- This allows `new Map()` to work directly while still permitting alternative implementations (e.g., `TreeMap`, `LinkedHashMap`).
- Alternative: Make them interfaces and use `HashMap`/`HashSet` directly.

**Indexed Collection Naming**

JavaScript/TypeScript uses `Array` for growable arrays, and most developers expect this.
We adopt JS-familiar naming while introducing interfaces for read-only access:

- `FixedArray<T>`: The WASM GC array primitive. Fixed-length, mutable, zero overhead.
- `Array<T>`: Growable array (interface or class). The most common collection type.
- `Sequence<T>`: Read-only indexed access interface. Common abstraction over `Array`, `FixedArray`, and `ReadonlyArray`.
- `ReadonlyArray<T>`: Immutable, fixed-length array (wrapper around `FixedArray`).

**Interface Hierarchy**:

```zena
interface Sequence<T> extends Iterable<T> {
  length: i32 {
    get();
  };
  get(index: i32): T;
  isEmpty(): boolean;
  contains(element: T): boolean;
  indexOf(element: T): i32;
}

interface Array<T> extends Sequence<T> {
  // Mutation operations
  set(index: i32, value: T): void;
  add(element: T): void;
  addAll(elements: Iterable<T>): void;
  insert(index: i32, element: T): void;
  removeAt(index: i32): T;
  clear(): void;
}
```

**Rationale**:

1. `Sequence<T>` provides a common interface for read-only indexed access, enabling
   code to work with any indexed collection without caring about mutability.
2. `FixedArray<T>` is the WASM primitive - useful for performance-critical code
   and as the backing store for `Array<T>`.
3. `ReadonlyArray<T>` is useful for APIs that want to return immutable data.
4. Fixed-length mutable arrays (`FixedArray`) are an edge case; most users want
   growable (`Array`) or fully immutable (`ReadonlyArray`) collections.

### Phase 3: Iteration & Utilities

Abstractions that make collection usage ergonomic and enable functional patterns.

| Type            | Description                             | Priority |
| --------------- | --------------------------------------- | -------- |
| `Iterator<T>`   | Stateful iterator interface             | ✅ Done  |
| `Iterable<T>`   | Collection that can produce an Iterator | ✅ Done  |
| `Comparable<T>` | Interface for ordered comparisons       | Medium   |
| `Hashable`      | Interface for custom hash codes         | Medium   |
| `StringBuilder` | Efficient string construction           | ✅ Done  |

**Iterator Design**

Inspired by Rust/Java iterators:

```zena
interface Iterator<T> {
  hasNext(): boolean;
  next(): T; // Or Option<T> if we have it
}

interface Iterable<T> {
  iterator(): Iterator<T>;
}
```

Once we have `for...of` loops, `Iterable<T>` becomes the protocol for iteration.

### Phase 4: Extended Utilities

Features for more sophisticated programs. Lower priority for MVP but important
for language completeness.

| Type/Module  | Description                                       | Priority |
| ------------ | ------------------------------------------------- | -------- |
| `zena:math`  | Math functions (sqrt, abs, min, max, trig, clamp) | Medium   |
| `Regex`      | Regular expressions (via WASM library)            | Low      |
| `Date`       | Date/time handling                                | Low      |
| `Promise<T>` | Async primitive                                   | Low      |
| `Duration`   | Time duration type                                | Low      |

---

## Detailed Type Specifications

### Core Classes (Phase 1 - Implemented)

#### 1. String

- **Backing**: UTF-8 bytes (WASM GC array).
- **Literal**: `"hello world"`
- **Intrinsics**: `length`, concatenation (`+`), equality (`==`, `!=`).
- **Status**: ✅ Implemented

See `docs/design/strings.md` for full details.

#### 2. FixedArray<T>

- **Backing**: WASM GC Array.
- **Literal**: `#[1, 2, 3]`
- **Intrinsics**: `get` (`[]`), `set` (`[]=`), `length`.
- **Status**: 🔄 Implemented as `Array<T>`, rename to `FixedArray<T>` pending

The low-level WASM GC array primitive. Fixed-length upon creation.
Most user code should use `Array<T>` (growable) or `ReadonlyArray<T>` (immutable).

See `docs/design/arrays.md` for full details.

#### 3. Console

- **Implementation**: Host interop via `@external` declarations.
- **API**: `console.log(message: string)`
- **Status**: ✅ Implemented

See `docs/design/host-interop.md` for full details.

---

### Collection Classes (Phase 2)

#### Sequence<T> (Interface)

A read-only interface for indexed collections. This is the common abstraction
over `Array<T>`, `FixedArray<T>`, and `ReadonlyArray<T>`.

```zena
interface Sequence<T> extends Iterable<T> {
  length: i32 {
    get();
  };
  get(index: i32): T;
  isEmpty(): boolean;
  contains(element: T): boolean;
  indexOf(element: T): i32;
  first(): T;
  last(): T;
}
```

#### Array<T> (Interface/Class)

The growable array interface. This is the most commonly used collection type.

```zena
interface Array<T> extends Sequence<T> {
  // Mutation operations
  set(index: i32, value: T): void;
  add(element: T): void;
  addAll(elements: Iterable<T>): void;
  insert(index: i32, element: T): void;
  removeAt(index: i32): T;
  clear(): void;

  // Derived operations
  subarray(start: i32, end: i32): Array<T>;
  join(separator: string): string;
}

// Default implementation backed by FixedArray<T>
class GrowableArray<T> implements Array<T> {
  #data: FixedArray<T>;
  #size: i32;

  #new() {
    this.#data = /* fixed array with capacity 16 */;
    this.#size = 0;
  }

  #new(capacity: i32) {
    this.#data = /* fixed array with specified capacity */;
    this.#size = 0;
  }

  // Implementation of Array<T> methods...

  // Additional methods
  ensureCapacity(minCapacity: i32): void;
  trimToSize(): void;
}
```

**Implementation Strategy**:

- Start with initial capacity of 16
- Double capacity when full
- Use `FixedArray<T>` as backing store
- Copy to new fixed array when growing

#### ReadonlyArray<T>

An immutable, fixed-length array wrapper.

```zena
class ReadonlyArray<T> implements Sequence<T> {
  #data: FixedArray<T>;

  #new(data: FixedArray<T>) {
    this.#data = data;
  }

  // Read-only Sequence<T> implementation
  // No mutation methods exposed
}
```

#### Map<K, V>

A key-value store. Can be an abstract class with a factory constructor.

```zena
abstract class Map<K, V> implements Iterable<Entry<K, V>> {
  // Factory constructor returns HashMap by default
  static #new<K, V>(): Map<K, V> {
    return new HashMap<K, V>();
  }

  // Read operations
  abstract length: i32 {
    get();
  }
  abstract get(key: K): V | null; // Or Option<V>
  abstract has(key: K): boolean;
  abstract isEmpty(): boolean;
  abstract keys(): Iterable<K>;
  abstract values(): Iterable<V>;
  abstract entries(): Iterable<Entry<K, V>>;

  // Write operations
  abstract set(key: K, value: V): void;
  abstract delete(key: K): boolean;
  abstract clear(): void;
}

class Entry<K, V> {
  key: K;
  value: V;
}
```

#### HashMap<K, V>

Hash-based Map implementation using open addressing or chaining.

```zena
class HashMap<K, V> extends Map<K, V> {
  #buckets: Array<Entry<K, V> | null>;
  #size: i32;

  #new() {
    this.#buckets = /* array of 16 null entries */;
    this.#size = 0;
  }

  // Implementation using hash codes and equality
}
```

**Hashing Strategy**:

- `i32`: Identity hash (value itself)
- `String`: FNV-1a or similar over UTF-8 bytes
- Objects: Require `Hashable` interface or use identity

See `docs/design/map.md` for implementation details.

#### Set<T>

A collection of unique elements.

```zena
abstract class Set<T> implements Iterable<T> {
  // Factory constructor returns HashSet by default
  static #new<T>(): Set<T> {
    return new HashSet<T>();
  }

  abstract length: i32 { get(); };
  abstract has(element: T): boolean;
  abstract isEmpty(): boolean;

  abstract add(element: T): boolean; // Returns true if added
  abstract delete(element: T): boolean;
  abstract clear(): void;

  // Set operations
  abstract union(other: Set<T>): Set<T>;
  abstract intersection(other: Set<T>): Set<T>;
  abstract difference(other: Set<T>): Set<T>;
}
```

#### HashSet<T>

Hash-based Set implementation. Internally uses `HashMap<T, boolean>` or a
dedicated structure.

```zena
class HashSet<T> extends Set<T> {
  #map: HashMap<T, boolean>;

  #new() {
    this.#map = new HashMap<T, boolean>();
  }

  // Delegate to internal map
}
```

#### Option<T>

A type-safe way to represent optional values (alternative to `null`).

```zena
abstract class Option<T> {
  abstract isSome(): boolean;
  abstract isNone(): boolean;
  abstract unwrap(): T; // Traps if None
  abstract unwrapOr(defaultValue: T): T;
  abstract map<U>(f: (value: T) => U): Option<U>;
}

class Some<T> extends Option<T> {
  #value: T;
  #new(value: T) {
    this.#value = value;
  }
  // ...
}

class None<T> extends Option<T> {
  // Singleton instance
}
```

**Alternative**: If Zena adds nullable types (`T?`), `Option<T>` may be less
critical but still useful for method chaining.

---

### Iteration Types (Phase 3)

#### Iterator<T>

```zena
interface Iterator<T> {
  hasNext(): boolean;
  next(): T;
}
```

#### Iterable<T>

```zena
interface Iterable<T> {
  iterator(): Iterator<T>;
}
```

**Future**: When `for...of` is implemented, it will desugar to:

```zena
// for (let x of collection) { ... }
// becomes:
let iter = collection.iterator();
while (iter.hasNext()) {
  let x = iter.next();
  // ...
}
```

#### Comparable<T>

For sortable types:

```zena
interface Comparable<T> {
  compareTo(other: T): i32; // -1, 0, or 1
}
```

#### Hashable

For types that can be used as Map/Set keys:

```zena
interface Hashable {
  hashCode(): i32;
  equals(other: Hashable): boolean;
}
```

#### StringBuilder

Efficient mutable string building using a rope/chunked approach:

```zena
import {StringBuilder} from 'zena:string-builder';

final class StringBuilder {
  #new(capacity: i32 = 16);

  length: i32 { get; }      // Current length in bytes
  capacity: i32 { get; }    // Total allocated capacity

  append(s: String): StringBuilder;
  appendByte(b: i32): StringBuilder;
  toString(): String;
  clear(): void;
}
```

**Implementation**: Uses a list of `ByteArray` chunks that grow as needed
(doubling strategy). The `append` method copies string bytes directly without
slice allocation when the string fits in the current chunk.

**Status**: ✅ Implemented in `zena:string-builder`

````

**Alternatives Considered**:

1. **Rope data structure**: Multiple internal string implementations (like Rope)
   with optimized `+` operator could make `StringBuilder` unnecessary. Ropes
   provide O(log n) concatenation but add complexity and may hurt small string
   performance.

2. **Array.join()**: Using `Array<string>.join(separator)` is a common pattern
   in JS. This is simpler than `StringBuilder` for many use cases.

**Recommendation**: Start with `StringBuilder` as the simple, explicit approach.
It's easy to implement and understand. Consider Rope-based strings as a future
optimization if profiling shows string concatenation is a bottleneck. `Array.join()`
is already included in the `Array<T>` interface above.

---

### Math Module (Phase 4)

Module: `zena:math`

The math module is split into two categories:

#### WASM Intrinsics (Zero-Cost)

These map directly to WASM instructions and have no runtime overhead:

```zena
// Rounding (f32.floor, f32.ceil, f32.trunc, f32.nearest)
export let floor = (x: f32): f32 => /* @intrinsic f32.floor */;
export let ceil = (x: f32): f32 => /* @intrinsic f32.ceil */;
export let trunc = (x: f32): f32 => /* @intrinsic f32.trunc */;
export let round = (x: f32): f32 => /* @intrinsic f32.nearest */;

// Roots & absolute value (f32.sqrt, f32.abs)
export let sqrt = (x: f32): f32 => /* @intrinsic f32.sqrt */;
export let absF32 = (x: f32): f32 => /* @intrinsic f32.abs */;

// Min/Max (f32.min, f32.max)
export let minF32 = (a: f32, b: f32): f32 => /* @intrinsic f32.min */;
export let maxF32 = (a: f32, b: f32): f32 => /* @intrinsic f32.max */;

// Copysign (f32.copysign)
export let copysign = (x: f32, y: f32): f32 => /* @intrinsic f32.copysign */;
````

#### Library Functions (Implemented in Zena or via Host)

These require implementation, either in pure Zena or via host delegation:

```zena
// Trigonometry - require Taylor series or host delegation
export let sin = (x: f32): f32 => /* library */;
export let cos = (x: f32): f32 => /* library */;
export let tan = (x: f32): f32 => /* library */;
export let asin = (x: f32): f32 => /* library */;
export let acos = (x: f32): f32 => /* library */;
export let atan = (x: f32): f32 => /* library */;
export let atan2 = (y: f32, x: f32): f32 => /* library */;

// Exponentials & logarithms
export let exp = (x: f32): f32 => /* library */;
export let log = (x: f32): f32 => /* library */;
export let log10 = (x: f32): f32 => /* library */;
export let pow = (base: f32, exp: f32): f32 => /* library */;

// Integer operations (pure Zena)
export let abs = (x: i32): i32 => if (x < 0) { -x } else { x };
export let min = (a: i32, b: i32): i32 => if (a < b) { a } else { b };
export let max = (a: i32, b: i32): i32 => if (a > b) { a } else { b };
export let clamp = (value: i32, lo: i32, hi: i32): i32 =>
  min(max(value, lo), hi);
export let clampF32 = (value: f32, lo: f32, hi: f32): f32 =>
  minF32(maxF32(value, lo), hi);

// Constants
export let PI: f32 = 3.14159265358979323846;
export let E: f32 = 2.71828182845904523536;
export let TAU: f32 = 6.28318530717958647692; // 2 * PI
```

**Implementation Strategy**:

For trigonometric and transcendental functions, we have two options:

1. **Host Delegation**: Call JavaScript's `Math.sin()`, etc. via `@external`.
   Simple but requires host environment.

2. **Pure Zena**: Implement using Taylor series or CORDIC algorithms.
   Self-contained but adds code size and may have precision tradeoffs.

**Recommendation**: Start with host delegation for MVP. Consider pure Zena
implementations later for environments without host math support.

---

### Future Considerations

#### Regex

Regular expressions are essential for parsers and text processing. Options:

1.  **Host Delegation**: Use JavaScript's `RegExp` via host interop
    - Pros: Simple, proven implementation
    - Cons: Requires host calls, limited to JS environments

2.  **WASM Library**: Compile a regex engine like RE2 to WASM
    - Pros: Self-contained, works anywhere
    - Cons: Binary size increase, implementation effort
    - Reference: [re2-wasm](https://github.com/nickmccurdy/nickmccurdy/issues/5)

3.  **Hand-rolled Parser Combinators**: Provide parsing utilities without full regex
    - Pros: Pure Zena, composable
    - Cons: Less powerful than regex for some use cases

**Recommendation**: Start with host delegation for JavaScript environments.
Consider a WASM-native solution later.

#### Date & Time

Date handling is notoriously complex. Options:

1.  **Simple Date Class**: Basic date/time storage and formatting
    - Sufficient for logging, basic timestamps
    - No timezone complexity initially

2.  **Host Delegation**: Use JavaScript's `Date` or Temporal API
    - Pros: Comprehensive, handles timezones
    - Cons: Host dependency

3.  **WASM Temporal Library**: Port a Rust temporal library
    - Pros: Self-contained
    - Cons: Significant binary size

**Recommendation**: Defer full date support. For MVP, expose host `Date.now()`
for timestamps.

```zena
@external("env", "now")
declare function now(): f64;  // Milliseconds since epoch
```

#### Promise<T> & Async

Async primitives require:

1.  A scheduler (event loop or host integration)
2.  `async`/`await` syntax in the language
3.  Promise resolution/rejection mechanics

**Recommendation**: Defer until language supports async syntax. In the meantime,
callback-based APIs can be used for host interop.

#### Scheduler / Timers

For `setTimeout`, `setInterval`, etc.:

```zena
@external("env", "setTimeout")
declare function setTimeout(callback: () => void, ms: i32): i32;

@external("env", "clearTimeout")
declare function clearTimeout(id: i32): void;
```

These require closures to work well. Defer until closure support is complete.

---

## Compiler Intrinsics

To implement low-level operations or map directly to WASM instructions, we need
a way to declare "native" or "intrinsic" methods in Zena source files.

**Implementation: `@intrinsic` Decorator**

```zena
class Array<T> {
  // Maps to array.len instruction
  @intrinsic('array.len')
  declare length: i32 { get(); };

  // Implemented in Zena
  isEmpty(): boolean {
    return this.length == 0;
  }
}
```

The compiler's code generator will detect the `@intrinsic` marker and emit the
corresponding WASM instruction. Methods marked with `@intrinsic` MUST be declared
using the `declare` keyword and cannot have a body.

**Note**: The `@intrinsic` decorator is currently restricted to modules within the `zena:` namespace (Standard Library) to prevent unsafe usage in user code.

### Supported Intrinsics

1.  **Array Operations**:
    - `array.len`: Maps to `array.len`.
    - `array.get`: Maps to `array.get`.
    - `array.set`: Maps to `array.set`.

2.  **Planned Intrinsics**:
    - **Math Operations**: `f32.sqrt`, `f32.floor`, `f32.ceil`, `f32.min`, `f32.max`
    - **Memory Operations**: `ref.eq`, `ref.is_null`
    - **Type Operations**: `ref.cast`, `ref.test`

### Global Intrinsics (Internal)

In addition to the `@intrinsic` decorator, the compiler supports a set of global intrinsic functions. These are primarily used for bootstrapping the standard library and implementing language features. They are identified by the `__array_` prefix.

| Function      | Signature                                         | Description                                                               | WASM Opcode |
| :------------ | :------------------------------------------------ | :------------------------------------------------------------------------ | :---------- |
| `__array_len` | `(array: Array<T>) => i32`                        | Returns the length of the array.                                          | `array.len` |
| `__array_get` | `(array: Array<T>, index: i32) => T`              | Gets the element at the specified index.                                  | `array.get` |
| `__array_set` | `(array: Array<T>, index: i32, value: T) => void` | Sets the element at the specified index.                                  | `array.set` |
| `__array_new` | `(size: i32, default: T) => Array<T>`             | Creates a new array of the specified size, filled with the default value. | `array.new` |

---

## Module System

### 1. File-based Modules

- Each `.zena` file is a module.
- Imports/Exports use ES-style syntax.

### 2. Standard Library Namespace

Standard library modules use the `zena:` prefix:

```zena
import {sqrt, PI} from 'zena:math';
import {HashMap} from 'zena:collections';
```

### 3. The "Prelude"

- The compiler automatically imports a "Prelude" module.
- Prelude exports: `String`, `FixedArray`, `Array`, `ByteArray`, core primitives.
- These are available without explicit import.

### 4. Compilation Pipeline

1.  **Parse**: Parse user code AND stdlib modules.
2.  **Type Check**: Check against combined scope (User + Prelude + Imports).
3.  **Reachability Analysis (Tree Shaking)**:
    - Start with exported functions and `main`.
    - Mark all reachable code.
4.  **Codegen**: Generate WASM only for reachable items.

---

## Implementation Priorities

### Immediate (Blocks MVP Programs)

1.  [x] `Array<T>` / `GrowableArray<T>` - Growable array is essential for parsers
2.  [x] `HashMap<K, V>` - Key-value storage for symbol tables, caches
3.  [x] `Iterator<T>` / `Iterable<T>` - Iteration protocol
4.  [x] `StringBuilder` - Efficient string construction

### Short-term (Quality of Life)

5.  [ ] `HashSet<T>` - Unique collections
6.  [ ] `Option<T>` - Type-safe optionals
7.  [ ] `zena:math` - Basic math functions (intrinsics first, then library)
8.  [ ] `Sequence<T>` interface - Abstract over indexed collections
9.  [ ] `ReadonlyArray<T>` - Immutable array wrapper

### Medium-term (Language Completeness)

10. [ ] `for...of` loop integration with `Iterable<T>`
11. [ ] `Comparable<T>` - Enable sorting
12. [ ] `Result<T, E>` - Error handling
13. [ ] String methods: `substring`, `indexOf`, `split`, `trim`

### Long-term (Advanced Features)

14. [ ] Regex support (host delegation initially)
15. [ ] Date/Time (minimal, host delegation)
16. [ ] Async primitives (requires language support)
17. [ ] TreeMap, LinkedHashMap, etc.
18. [ ] Rope-based string implementation (optimization)

---

## Challenges

### Circular Dependencies

The stdlib may have circular dependencies (e.g., `Map` uses `Array`, `String`
uses `Array`). The compiler must handle these gracefully during module
resolution.

### Generic Constraints

`HashMap<K, V>` requires `K` to be hashable and comparable. Options:

1.  **Runtime**: Check at runtime (trap if not hashable)
2.  **Constraints**: `K extends Hashable` (requires generic constraints)
3.  **Special-casing**: Built-in handling for primitives and strings

**Recommendation**: Start with built-in handling for `i32`, `f32`, `string`.
Add `Hashable` constraint support later.

### Null Safety

The stdlib needs a clear strategy for handling missing values:

- `Map.get(key)` when key doesn't exist
- `List.first()` on empty list

Options:

1.  Return `null` with nullable types (`T?`)
2.  Return `Option<T>`
3.  Trap on invalid access (with `tryGet` variants that return `Option`)

**Recommendation**: Use nullable return types initially (`T | null`). Add
`Option<T>` for cases where method chaining is desired.

---

## Console Module (Implemented)

The `Console` module provides basic I/O operations.

**Implementation**: `packages/stdlib/zena/console.zena`

**API**:

```zena
export let log = (val: i32) => { ... };
export let logF32 = (val: f32) => { ... };
```

**Usage**:

```zena
log(42);
```

**Host Requirements**:
The host environment must provide `console.log` via the import object. The
`@zena-lang/runtime` package handles this automatically.

---

## Summary

The MVP Standard Library focuses on enabling practical programs like parsers and
data processors. The phased approach ensures we build foundational types first
(`FixedArray`, `String`), then essential collections (`Array`, `HashMap`),
followed by iteration utilities and finally advanced features.

Key design decisions:

- **JS-familiar naming**: `Array<T>` is the growable array (like JS), `FixedArray<T>` is the WASM primitive
- **Interface hierarchy**: `Sequence<T>` provides read-only indexed access across all array types
- **Dart-inspired**: Clean separation of interfaces and implementations
- **Zero-overhead**: Dead code elimination ensures unused stdlib code isn't shipped
- **Pragmatic**: Start simple, expand based on real needs
- **WASM-native**: Leverage WASM GC primitives directly where possible
- **Math split**: WASM intrinsics (sqrt, floor, etc.) vs library functions (sin, cos, etc.)
