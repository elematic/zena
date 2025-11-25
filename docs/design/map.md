# Map Implementation Design

## Overview

The `Map` type provides a mutable key-value store. It should be implemented as a
class in the Rhea Standard Library.

## Data Structure

We will use a **Hash Map** with **Open Addressing** (Linear Probing) or
**Chaining** (Linked Lists). Given WASM GC's strengths, Chaining with a
fixed-size array of buckets might be simpler to implement initially, or Open
Addressing to minimize allocations.

### Proposed Layout (Chaining)

```typescript
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

## Hashing

To support `Map`, we need a way to hash keys.

- **Primitives**:
  - `i32`: Identity hash (value itself).
  - `string`: FNV-1a or similar hash algorithm over bytes.
- **Objects**:
  - Need a `hashCode()` method on `Object` or an interface `Hashable`.
  - Default identity hash (address-based) is tricky in WASM GC as addresses
    can move. `externref` might provide stable identity, or we assign a
    unique ID to each object on creation.

## Equality

Keys must be comparable for equality.

- **Primitives**: Value equality.
- **Objects**: Reference equality by default, or `equals()` method.

## Generics Requirement

To implement `Map` in Rhea, we strongly need **Generics**.

Without generics, we would have to:

1.  Implement `Map` using `any` (boxing everything), losing type safety and
    performance.
2.  Or, implement specific maps (`StringIntMap`, `IntStringMap`), which is not
    scalable.

**Proposal**: Implement basic Generics (Monomorphization) before or alongside
`Map`.

- `class Map<K, V> { ... }`
- Compiler generates specialized versions (e.g., `Map_i32_string`) for each
  instantiation.

## API

```typescript
class Map<K, V> {
  set(key: K, value: V): void;
  get(key: K): V | null; // Needs Option/Nullable support? Or throws? Or returns default?
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
}
```
