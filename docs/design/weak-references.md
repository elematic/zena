# Weak References and Identity-Keyed Containers

This document designs `IdentityMap`, `WeakMap`, and `WeakRef` for Zena.

## Problem

Two missing primitives on wasm GC, not one:

1. **No weak references.** The wasm GC MVP has none; `WeakMap`/`WeakRef`
   are [Post-MVP extensions](https://github.com/WebAssembly/gc/blob/main/proposals/gc/Post-MVP.md#weak-references).
2. **No identity hash.** `ref.eq` exists, but there is no address or
   identity-hash instruction — so even a _strong_ identity-keyed map has
   no O(1) implementation without per-object storage. (This is why
   `Hashable` is permanently opt-in for classes — see
   [equality.md](equality.md) D6.)

The two problems have different solutions with different portability,
and separating them is the core of this design:

| Container                | Needs identity hash | Needs weakness | Availability                                 |
| ------------------------ | ------------------- | -------------- | -------------------------------------------- |
| `IdentityMap` (strong)   | yes                 | no             | **all hosts, today** (§Injection)            |
| `WeakMap`                | yes                 | yes            | **all hosts, today** (§Inverted, one caveat) |
| `WeakRef` / finalization | no                  | yes            | JS hosts now; pure wasm post-MVP             |

Keys are **classes only**: records and tuples have no identity
(records-and-tuples.md §3.1) and are rejected as `K` at instantiation.

## Identity hashing: compiler-injected hash fields

The compiler injects a hidden `#idHash: i32` field into exactly the
class hierarchies that are used as identity keys, discovered by RTA:
every instantiation `IdentityMap<K, V>` (or `WeakMap<K, V>`) marks its
concrete `K`.

- **Precedent**: object layout is already whole-program-derived — ZIR
  §10.2 _removes_ the hidden vtable field from classes never
  dynamically dispatched; this is the same power in the other
  direction.
- **Initialization**: eager, from a global counter at construction —
  branch-free, one increment; sequential values are fine because the
  hash containers mix (hash-implementation.md).
- **Cost**: 4 bytes per instance _of the keyed hierarchies only_, plus
  the increment.

**The footgun and the bound rule that kills it.** A broad key type
(`IdentityMap<anyref, V>`) would smear the field across every class.
Therefore:

- `K` must resolve to a **named class hierarchy** (a concrete class or
  an explicit root; subclasses inherit the field). The blast radius is
  the hierarchy written in the type, visible at the instantiation site.
- `K = anyref` is a compile error ("identity-keyed maps require a class
  key — identity hashing must be materialized per class on wasm GC").
- Interface-typed `K` is rejected in v1 (supportable later via a
  synthesized vtable accessor, but it reintroduces breadth — defer
  until wanted).
- Record/tuple `K` is rejected (no identity).
- A `ZENA_STATS`-style diagnostic lists every class that received the
  field and which instantiation caused it.

Semantically the requirement is an interface (`K extends
IdentityHashable`); the compiler **auto-derives** it (injecting the
field) for any `K` satisfying the bound rules, and a class may also
declare `with IdentityHash` explicitly to pre-commit and document the
cost. Because derivation can never fire for `anyref`/interfaces/broad
types, the inference is safe to offer; the bound rules — not ceremony —
are what prevent the field from spreading.

## IdentityMap

A strong map keyed by `===` and `#idHash`. Ordinary open-addressed hash
map otherwise; monomorphized per `K`/`V`; works identically on every
host, today. This is the sanctioned home for the identity-keyed
patterns that `==` and records deliberately do not serve
(equality.md D1/D2).

## WeakMap: inverted storage (primary design)

Pure-wasm `WeakMap` does **not** wait for the post-MVP weakness
proposal. Invert the storage — the entry lives on the _key_, not in the
map:

- `map.set(k, v)` stores `v` in an injected field of `k`, tagged by the
  map's identity. The `WeakMap` object itself is only an identity
  token; it holds no per-entry storage.
- **Weakness falls out of ordinary tracing.** `v` is alive iff `k` is
  alive (plus other refs). Even the classic ephemeron trap — `v`
  references `k`, so a naive weak table keeps both alive — dissolves:
  it is just a `k → field → v → k` cycle, collected the moment `k` is
  externally unreachable, because there is no map-side table. Correct
  ephemeron semantics, no collector support required.
- **Injected storage shape**: a class can be keyed by many `WeakMap`
  _instances_, so the general field is
  `#weakEntries: IdentityMap<WeakMapToken, anyref> | null`, lazily
  allocated on first `set`; the monomorphized `WeakMap<K, V>` wrapper
  performs the `ref.cast` to `V` on read. When whole-program analysis
  shows a class is keyed by only one weak-map instantiation, the table
  specializes to a direct `#wm_value: V | null` field. (The tokens'
  own identity hashes come from the same injection mechanism,
  self-bounded.)
- **Bound rules**: identical to IdentityMap's (named class hierarchy;
  no `anyref`/interface/record keys; stats diagnostic).

**Known deviation — map-death leak.** JS semantics also reclaim entries
when the _map_ dies while keys survive. Inverted storage cannot detect
a dead token without weak refs, so a dropped `WeakMap` whose keys
survive pins its values until those keys die. The leak is bounded by
surviving-keys-of-dropped-maps; the dominant uses (caches and
side-tables where the map outlives the keys) never hit it, and the
historical JS `WeakMap` polyfills shipped with exactly this deviation
for years. Documented loudly; revisited when wasm weakness lands.

Non-iterability and absent `size` match JS `WeakMap` exactly (that API
is deliberately non-observable there for the same reasons).

**Default on all hosts.** Identical semantics everywhere beats per-host
fidelity, so the inverted implementation is the default even on JS
hosts; the host-delegated backend below remains available if map-death
reclamation ever matters to a specific use.

## Host delegation: WeakRef, finalization, and the alternative WeakMap backend

`WeakRef` (and any future finalization) cannot be built by inversion —
observing the death of an object you do not own storage inside
genuinely requires collector support. These remain host-delegated on JS
hosts and unavailable in pure wasm until the post-MVP proposal lands.

Zena objects (WASM GC structs/arrays) are opaque to JavaScript, but
they can be passed to the host as `externref` (identity round-trips
through `extern.convert_any`/`any.convert_extern`). The strategy is to
wrap the native JavaScript `WeakMap` and `WeakRef` objects and expose
them to Zena via `externref` handles.

## Implementation Plan

### 1. Compiler Prerequisites

To support this efficiently, the compiler needs to expose low-level WASM types and casting intrinsics to the standard library implementers.

- **Types**:
  - `externref`: Represents an opaque host reference (e.g., a JS `WeakMap`).
  - `anyref`: Represents any WASM GC object (the supertype of all reference types).

- **Intrinsics**:
  - `extern.convert_any`: Casts a Zena object (`anyref`) to a host reference (`externref`).
  - `any.convert_extern`: Casts a host reference (`externref`) back to a Zena object (`anyref`).
  - `ref.cast`: Casts `anyref` to a concrete Zena type (e.g., `K` or `V`).

### 2. Host Bindings (JavaScript)

The runtime library must provide helper functions to bridge the gap.

```javascript
// runtime/lib/index.js or similar
const imports = {
  env: {
    // WeakMap
    weakMapNew: () => new WeakMap(),
    weakMapSet: (map, key, value) => map.set(key, value),
    weakMapGet: (map, key) => map.get(key),
    weakMapHas: (map, key) => map.has(key),
    weakMapDelete: (map, key) => map.delete(key),

    // WeakRef
    weakRefNew: (target) => new WeakRef(target),
    weakRefDeref: (ref) => ref.deref(),
  },
};
```

### 3. Zena Standard Library Implementation

We can then implement `WeakMap` and `WeakRef` as wrapper classes in Zena.

#### WeakMap

```zena
// stdlib/weak-map.zena

// Host declarations
@external("env", "weakMapNew")
declare function host_weakMapNew(): externref;

@external("env", "weakMapSet")
declare function host_weakMapSet(map: externref, key: externref, value: externref): void;

@external("env", "weakMapGet")
declare function host_weakMapGet(map: externref, key: externref): externref;

@external("env", "weakMapHas")
declare function host_weakMapHas(map: externref, key: externref): boolean;

@external("env", "weakMapDelete")
declare function host_weakMapDelete(map: externref, key: externref): boolean;

export class WeakMap<K, V> {
  #handle: externref;

  new() {
    this.#handle = host_weakMapNew();
  }

  set(key: K, value: V): void {
    // Implicit cast K -> anyref -> externref
    // Ideally we have an explicit way to do this, e.g. Unsafe.castToExtern(key)
    host_weakMapSet(this.#handle, key as externref, value as externref);
  }

  get(key: K): V | null {
    const valRef = host_weakMapGet(this.#handle, key as externref);

    // Check for null (externref can be null)
    if (valRef == null) { // Assuming null check works on externref
      return null;
    }

    // Cast externref -> anyref -> V
    return valRef as V;
  }

  has(key: K): boolean {
    return host_weakMapHas(this.#handle, key as externref);
  }

  delete(key: K): boolean {
    return host_weakMapDelete(this.#handle, key as externref);
  }
}
```

#### WeakRef

```zena
// stdlib/weak-ref.zena

@external("env", "weakRefNew")
declare function host_weakRefNew(target: externref): externref;

@external("env", "weakRefDeref")
declare function host_weakRefDeref(ref: externref): externref;

export class WeakRef<T> {
  #handle: externref;

  new(target: T) {
    this.#handle = host_weakRefNew(target as externref);
  }

  deref(): T | null {
    const targetRef = host_weakRefDeref(this.#handle);
    if (targetRef == null) {
      return null;
    }
    return targetRef as T;
  }
}
```

## Portability & Host Support

This design relies heavily on the host environment's capabilities.

### JavaScript Hosts (V8, SpiderMonkey, JavaScriptCore)

This strategy works **perfectly** in JavaScript environments (Browsers, Node.js, Deno, Bun).

- JS engines integrate Wasm GC with the JS Garbage Collector.
- A JS `WeakMap` can hold a Wasm GC object (passed as `anyref` -> `externref`) as a key.
- The JS GC correctly tracks liveness across the boundary and collects the Wasm object when no other references exist.

### Non-JS Hosts (Wasmtime, Wasmer, WAMR)

Support in standalone Wasm runtimes is **more complex and currently limited**.

1.  **Host Objects (`externref`) as Keys/Targets**:
    - If the key/target is a Host Object (e.g., a Python object in a Python host), this works fine, provided the host language has weak reference support.

2.  **Wasm Objects (`anyref`) as Keys/Targets**:
    - **Current Limitation**: Most standalone runtimes (like Wasmtime) expose Wasm GC objects to the host via "Strong Handles" (e.g., `Rooted<T>`). They do not yet universally expose "Weak Handles" to Wasm GC objects.
    - **Consequence**: If you put a Zena object into a Host Map, the Host holds a **strong reference** to it. The Zena object will never be collected, causing a memory leak.
    - **Future**: As Wasm GC matures, embedding APIs will likely add support for Weak Handles to allow hosts to participate in the Wasm GC cycle.

**Conclusion (revised)**: with the inverted design, `IdentityMap` and
`WeakMap` for Zena objects work on **all** hosts today (`WeakMap` with
the documented map-death deviation). Only `WeakRef`/finalization remain
JS-host-only until wasm weakness ships — at which point the injected
identity-hash fields are already in place for a native ephemeron-table
backend, and the map-death deviation can be closed.
