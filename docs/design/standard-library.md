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

| Type        | Description                        | Priority |
| ----------- | ---------------------------------- | -------- |
| `String`    | Immutable UTF-8 string             | ✅ Done  |
| `ByteArray` | Mutable byte array (backs strings) | ✅ Done  |
| `Array<T>`  | Fixed-length WASM GC array         | ✅ Done  |
| `boolean`   | Boolean primitive                  | ✅ Done  |
| `i32`       | 32-bit signed integer              | ✅ Done  |
| `f32`       | 32-bit float                       | ✅ Done  |
| `void`      | Unit type                          | ✅ Done  |
| `Console`   | Basic I/O via host interop         | ✅ Done  |

### Phase 2: Collections (Essential Data Structures)

Types needed for building real programs. A parser, for example, needs growable
lists and key-value storage.

| Type           | Description                            | Priority |
| -------------- | -------------------------------------- | -------- |
| `List<T>`      | Growable array-backed list (interface) | High     |
| `ArrayList<T>` | Growable list implementation           | High     |
| `Map<K, V>`    | Key-value store (interface or class)   | High     |
| `HashMap<K,V>` | Hash-based Map implementation          | High     |
| `Set<T>`       | Unique collection (interface or class) | Medium   |
| `HashSet<T>`   | Hash-based Set implementation          | Medium   |
| `Option<T>`    | Optional value wrapper (Some/None)     | Medium   |
| `Result<T,E>`  | Success/Error wrapper                  | Medium   |

**Design Decision: Interface vs Class**

For `Map` and `Set`, we follow Dart's pragmatic approach:

- `Map<K, V>` and `Set<T>` can be **abstract classes** with factory constructors that return the default hash-based implementation.
- This allows `new Map()` to work directly while still permitting alternative implementations (e.g., `TreeMap`, `LinkedHashMap`).
- Alternative: Make them interfaces and use `HashMap`/`HashSet` directly.

**Array vs List Distinction**

- `Array<T>`: Fixed-length, maps directly to WASM GC arrays. Non-growable but zero overhead.
- `List<T>`: Abstract interface for indexed, iterable collections.
- `ArrayList<T>`: Growable list backed by an `Array<T>` with capacity management.

`Array<T>` should NOT implement `List<T>` directly because:

1. WASM GC arrays cannot be subclassed (they're primitives)
2. `List<T>` may have mutable operations (`add`, `remove`) that don't make sense for fixed arrays
3. Instead, we can provide `Array.toList()` or `ArrayList.from(array)`

### Phase 3: Iteration & Utilities

Abstractions that make collection usage ergonomic and enable functional patterns.

| Type            | Description                             | Priority |
| --------------- | --------------------------------------- | -------- |
| `Iterator<T>`   | Stateful iterator interface             | High     |
| `Iterable<T>`   | Collection that can produce an Iterator | High     |
| `Comparable<T>` | Interface for ordered comparisons       | Medium   |
| `Hashable`      | Interface for custom hash codes         | Medium   |
| `StringBuilder` | Efficient string construction           | Medium   |

**Iterator Design**

Inspired by Rust/Java iterators:

```typescript
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

#### 2. Array<T>

- **Backing**: WASM GC Array.
- **Literal**: `#[1, 2, 3]`
- **Intrinsics**: `get` (`[]`), `set` (`[]=`), `length`.
- **Status**: ✅ Implemented

See `docs/design/arrays.md` for full details.

#### 3. Console

- **Implementation**: Host interop via `@external` declarations.
- **API**: `console.log(message: string)`
- **Status**: ✅ Implemented

See `docs/design/host-interop.md` for full details.

---

### Collection Classes (Phase 2)

#### List<T> (Interface)

An abstract interface for indexed, growable collections.

```typescript
interface List<T> extends Iterable<T> {
  // Read operations
  get length(): i32;
  get(index: i32): T;
  isEmpty(): boolean;
  contains(element: T): boolean;
  indexOf(element: T): i32;

  // Write operations (mutable)
  set(index: i32, value: T): void;
  add(element: T): void;
  addAll(elements: Iterable<T>): void;
  insert(index: i32, element: T): void;
  removeAt(index: i32): T;
  clear(): void;

  // Derived operations
  first(): T;
  last(): T;
  sublist(start: i32, end: i32): List<T>;
}
```

#### ArrayList<T>

A growable list backed by a dynamic array with capacity management.

```typescript
class ArrayList<T> implements List<T> {
  #data: Array<T>;
  #size: i32;

  #new() {
    this.#data = #[]; // Initial capacity TBD
    this.#size = 0;
  }

  #new(capacity: i32) {
    // Pre-allocate with capacity
  }

  // Implementation of List<T> methods...

  // Additional methods
  ensureCapacity(minCapacity: i32): void;
  trimToSize(): void;
}
```

**Implementation Strategy**:

- Start with initial capacity of 16
- Double capacity when full
- Use `Array<T>` as backing store
- Copy to new array when growing

#### Map<K, V>

A key-value store. Can be an abstract class with a factory constructor.

```typescript
abstract class Map<K, V> implements Iterable<Entry<K, V>> {
  // Factory constructor returns HashMap by default
  static #new<K, V>(): Map<K, V> {
    return new HashMap<K, V>();
  }

  // Read operations
  abstract get length(): i32;
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

```typescript
class HashMap<K, V> extends Map<K, V> {
  #buckets: Array<Entry<K, V> | null>;
  #size: i32;

  #new() {
    this.#buckets = /* array of null with initial capacity */;
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

```typescript
abstract class Set<T> implements Iterable<T> {
  // Factory constructor returns HashSet by default
  static #new<T>(): Set<T> {
    return new HashSet<T>();
  }

  abstract get length(): i32;
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

```typescript
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

```typescript
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

```typescript
interface Iterator<T> {
  hasNext(): boolean;
  next(): T;
}
```

#### Iterable<T>

```typescript
interface Iterable<T> {
  iterator(): Iterator<T>;
}
```

**Future**: When `for...of` is implemented, it will desugar to:

```typescript
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

```typescript
interface Comparable<T> {
  compareTo(other: T): i32; // -1, 0, or 1
}
```

#### Hashable

For types that can be used as Map/Set keys:

```typescript
interface Hashable {
  hashCode(): i32;
  equals(other: Hashable): boolean;
}
```

#### StringBuilder

Efficient mutable string building:

```typescript
class StringBuilder {
  #buffer: ByteArray;
  #length: i32;

  #new() {
    /* ... */
  }

  append(s: string): StringBuilder;
  appendChar(c: i32): StringBuilder; // Byte value
  toString(): string;
  clear(): void;
}
```

---

### Math Module (Phase 4)

Module: `zena:math`

```typescript
// Trigonometry
export const sin = (x: f32): f32 => /* intrinsic */;
export const cos = (x: f32): f32 => /* intrinsic */;
export const tan = (x: f32): f32 => /* intrinsic */;
export const atan2 = (y: f32, x: f32): f32 => /* intrinsic */;

// Power & roots
export const sqrt = (x: f32): f32 => /* intrinsic */;
export const pow = (base: f32, exp: f32): f32 => /* intrinsic */;
export const abs = (x: i32): i32 => /* ... */;
export const absF32 = (x: f32): f32 => /* intrinsic */;

// Min/Max/Clamp
export const min = (a: i32, b: i32): i32 => /* ... */;
export const max = (a: i32, b: i32): i32 => /* ... */;
export const clamp = (value: i32, min: i32, max: i32): i32 => /* ... */;

export const minF32 = (a: f32, b: f32): f32 => /* intrinsic */;
export const maxF32 = (a: f32, b: f32): f32 => /* intrinsic */;
export const clampF32 = (value: f32, min: f32, max: f32): f32 => /* ... */;

// Rounding
export const floor = (x: f32): f32 => /* intrinsic */;
export const ceil = (x: f32): f32 => /* intrinsic */;
export const round = (x: f32): f32 => /* intrinsic */;
export const trunc = (x: f32): f32 => /* intrinsic */;

// Constants
export const PI: f32 = 3.14159265358979323846;
export const E: f32 = 2.71828182845904523536;
```

WASM provides many of these as native instructions (`f32.sqrt`, `f32.floor`,
etc.), making them zero-cost intrinsics.

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

```typescript
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

```typescript
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

**Proposal: `@intrinsic` Decorator**

```typescript
class Array<T> {
  // Maps to array.len instruction
  @intrinsic('array.len')
  get length(): i32 {
    return 0;
  } // Body is ignored or used as fallback/stub

  // Implemented in Zena
  isEmpty(): boolean {
    return this.length == 0;
  }
}
```

The compiler's code generator will detect the `@intrinsic` marker and emit the
corresponding WASM instruction instead of compiling the function body.

### Intrinsic Categories

1.  **Array Operations**: `array.len`, `array.get`, `array.set`, `array.new`
2.  **Math Operations**: `f32.sqrt`, `f32.floor`, `f32.ceil`, `f32.min`, `f32.max`
3.  **Memory Operations**: `ref.eq`, `ref.is_null`
4.  **Type Operations**: `ref.cast`, `ref.test`

---

## Module System

### 1. File-based Modules

- Each `.zena` file is a module.
- Imports/Exports use ES-style syntax.

### 2. Standard Library Namespace

Standard library modules use the `zena:` prefix:

```typescript
import {sqrt, PI} from 'zena:math';
import {HashMap} from 'zena:collections';
```

### 3. The "Prelude"

- The compiler automatically imports a "Prelude" module.
- Prelude exports: `String`, `Array`, `ByteArray`, core primitives.
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

1.  [ ] `ArrayList<T>` - Growable list is essential for parsers
2.  [ ] `HashMap<K, V>` - Key-value storage for symbol tables, caches
3.  [ ] `Iterator<T>` / `Iterable<T>` - Iteration protocol
4.  [ ] `StringBuilder` - Efficient string construction

### Short-term (Quality of Life)

5.  [ ] `HashSet<T>` - Unique collections
6.  [ ] `Option<T>` - Type-safe optionals
7.  [ ] `zena:math` - Basic math functions
8.  [ ] `List<T>` interface - Abstract over array types

### Medium-term (Language Completeness)

9.  [ ] `for...of` loop integration with `Iterable<T>`
10. [ ] `Comparable<T>` - Enable sorting
11. [ ] `Result<T, E>` - Error handling
12. [ ] String methods: `substring`, `indexOf`, `split`, `trim`

### Long-term (Advanced Features)

13. [ ] Regex support (host delegation initially)
14. [ ] Date/Time (minimal, host delegation)
15. [ ] Async primitives (requires language support)
16. [ ] TreeMap, LinkedHashMap, etc.

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

**Implementation**: `packages/compiler/stdlib/console.zena`

**API**:

```typescript
export let log = (val: i32) => { ... };
export let logF32 = (val: f32) => { ... };
```

**Usage**:

```typescript
log(42);
```

**Host Requirements**:
The host environment must provide `console.log` via the import object. The
`@zena-lang/runtime` package handles this automatically.

---

## Summary

The MVP Standard Library focuses on enabling practical programs like parsers and
data processors. The phased approach ensures we build foundational types first
(`Array`, `String`), then essential collections (`ArrayList`, `HashMap`),
followed by iteration utilities and finally advanced features.

Key design decisions:

- **Dart-inspired**: Clean separation of interfaces and implementations
- **Zero-overhead**: Dead code elimination ensures unused stdlib code isn't shipped
- **Pragmatic**: Start simple, expand based on real needs
- **WASM-native**: Leverage WASM GC primitives directly where possible
