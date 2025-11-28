# Weak References Design

This document outlines the design for implementing `WeakMap` and `WeakRef` in Zena.

## Problem

The current WebAssembly GC MVP (Minimum Viable Product) does not support weak references. Features like `WeakMap` and `WeakRef` are listed as [Post-MVP extensions](https://github.com/WebAssembly/gc/blob/main/proposals/gc/Post-MVP.md#weak-references).

However, Zena targets environments (like V8/Node.js/Browsers) that already have robust support for weak references in JavaScript.

## Solution: Host Interop

We can implement `WeakMap` and `WeakRef` by leveraging the host environment's capabilities. Zena objects (WASM GC structs/arrays) are opaque to JavaScript, but they can be passed to the host as `externref`.

The strategy is to wrap the native JavaScript `WeakMap` and `WeakRef` objects and expose them to Zena via `externref` handles.

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

```typescript
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

  #new() {
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

```typescript
// stdlib/weak-ref.zena

@external("env", "weakRefNew")
declare function host_weakRefNew(target: externref): externref;

@external("env", "weakRefDeref")
declare function host_weakRefDeref(ref: externref): externref;

export class WeakRef<T> {
  #handle: externref;

  #new(target: T) {
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

**Conclusion**: For now, `WeakMap` and `WeakRef` support for _Zena Objects_ is effectively limited to JavaScript hosts. Support for _Host Objects_ works anywhere the host allows it.
