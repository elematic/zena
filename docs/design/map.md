# Map Implementation Design

## Overview

The `Map` type provides a mutable key-value store. It should be implemented as a
class in the Zena Standard Library.

## Data Structure

We will use a **Hash Map** with **Open Addressing** (Linear Probing) or
**Chaining** (Linked Lists). Given WASM GC's strengths, Chaining with a
fixed-size array of buckets might be simpler to implement initially, or Open
Addressing to minimize allocations.

### Proposed Layout (Chaining)

```zena
class Map<K, V> {
  buckets: Array<Entry<K, V> | null>;
  size: i32;

  constructor() {
    this.buckets = new Array(16); // Initial capacity
    this.size = 0;
  }
}

class Entry<K, V> {
  key: K;
  value: V;
  next: Entry<K, V> | null;
}
```

## Hashing Strategy (Decided)

To support `Map`, we will use a **Protocol-based** approach rather than relying on object identity.

### 1. The `Hashable` Interface

We will introduce a standard interface `Hashable` for objects that can be used as keys.

```zena
interface Hashable {
  hashCode(): i32;
  operator ==(other: Hashable): boolean;
}
```

### 2. The `hash<T>` Intrinsic

Since primitives and structural types (Records/Tuples) cannot explicitly implement interfaces, we will introduce a compiler intrinsic function `hash<T>(value: T): i32`.

The compiler will generate specialized hashing logic based on the type `T`:

- **Primitives**:
  - `i32`, `boolean`: Returns the value (or 1/0).
  - `string`: Computes FNV-1a hash (or calls a runtime helper).
- **Records & Tuples**:
  - Computes a structural hash by combining the hashes of all fields (e.g., `hash = hash * 31 + fieldHash`).
  - This enables **Composite Keys** (e.g., `Map<[i32, i32], string>`).
- **Classes**:
  - Checks if the class implements `Hashable`.
  - If yes: Calls `value.hashCode()`.
  - If no: This is a **Compile-Time Error** (or Runtime Error if generic constraints are insufficient). We explicitly **reject** default identity hashing for now due to WASM-GC object movement and the cost of adding hidden hash fields to all objects.

## Equality

Equality checks in `Map` will follow the same pattern:

- **Primitives**: Value equality (`==`).
- **Records & Tuples**: Structural equality (recursive check of fields).
- **Classes**:
  - If `Hashable`: Calls `value == other` (via `operator ==`).
  - Default: Reference equality (`ref.eq`).

## API

```zena
class Map<K, V> {
  // Basic Access
  operator []=(key: K, value: V): void;
  operator [](key: K): V | null;

  // Computed Access (Upsert / Cache pattern)
  // If key exists, returns value.
  // If not, calls ifAbsent(key), inserts result, and returns it.
  get(key: K, ifAbsent?: (key: K) => V): V | null;

  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;

  get size(): i32;
}
```
