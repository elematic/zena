# Interface Design & Implementation

This document details the implementation of Interfaces in Rhea, specifically
focusing on the runtime representation and dispatch mechanism using **Fat
Pointers**.

## 1. Overview

Rhea uses a **Nominal Type System** where interfaces are explicit contracts.
While classes map directly to WASM structs, interfaces require a different
runtime representation because WASM-GC does not natively support "protocol" or
"trait" types that span across disjoint class hierarchies.

To support treating an interface as a value (e.g., `let r: Runnable = ...`) and
invoking methods on it, we use the **Fat Pointer** (or Interface Object)
approach.

## 2. Runtime Representation: Fat Pointers

An interface value at runtime is not just a pointer to the object. It is a
heap-allocated struct containing two fields:

1.  **Instance**: A reference to the underlying object (erased to `any` / `eq`).
2.  **VTable**: A reference to a struct containing function pointers specific to
    this interface.

### 2.1. Interface Struct Layout

For an interface `Runnable`:

```typescript
interface Runnable {
  run(): void;
}
```

The compiler generates a WASM struct type:

```wat
(type $Runnable (struct
  (field $instance (ref null any))      ;; The underlying object
  (field $vtable (ref $RunnableVTable)) ;; The dispatch table
))
```

### 2.2. VTable Layout

The VTable struct contains function pointers for every method defined in the
interface. Crucially, the first parameter of these functions is `any` (the
erased type of `$instance`), not the specific class type.

```wat
(type $RunnableVTable (struct
  (field $run (ref (func (param any)))) ;; run() taking 'any'
))
```

## 3. Implementation Details

### 3.1. Trampolines (Thunks)

When a class implements an interface, its methods expect `this` to be of the
class type (e.g., `(ref $Task)`). However, the interface VTable expects `(ref
any)`.

To bridge this gap, we generate **Trampoline Functions** for each
Class-Interface pair. These trampolines cast the `any` reference back to the
specific class type and call the actual method.

**Example:**

```typescript
class Task implements Runnable {
  run(): void { ... }
}
```

**Generated Trampoline:**

```wat
;; Trampoline for Task implementing Runnable.run
(func $Task_Runnable_run (param $this_any any)
  (local $this_task (ref null $Task))

  ;; 1. Cast 'any' back to 'Task'
  (local.set $this_task (ref.cast $Task (local.get $this_any)))

  ;; 2. Call the real method
  (call $Task_run (local.get $this_task))
)
```

### 3.2. Instantiation (Boxing)

When assigning a class instance to an interface variable, we allocate the
Interface Struct (the Fat Pointer).

```typescript
let t = new Task();
let r: Runnable = t; // Implicit conversion
```

**Compiles to:**

```wat
;; 1. Create Task
(local.set $t (call $Task_new))

;; 2. Create Runnable (Fat Pointer)
(local.set $r
  (struct.new $Runnable
    (local.get $t)                  ;; $instance
    (global.get $Task_Runnable_VTable) ;; $vtable (Singleton)
  )
)
```

### 3.3. Method Dispatch

To call a method on an interface:

```typescript
r.run();
```

**Compiles to:**

```wat
;; 1. Load VTable
(local.set $vt (struct.get $Runnable 1 (local.get $r)))

;; 2. Load Function Pointer from VTable
(local.set $fn (struct.get $RunnableVTable 0 (local.get $vt)))

;; 3. Load Instance
(local.set $inst (struct.get $Runnable 0 (local.get $r)))

;; 4. Call Function
(call_ref $fn (local.get $inst))
```

## 4. Rationale

### Why Fat Pointers?

1.  **WASM Alignment**: This approach maps cleanly to WASM-GC structs. It avoids
    complex runtime searching (like Itables) or modifying the object header
    (which would complicate the single-inheritance model).
2.  **Performance**: Dispatch is fast (Load -> Load -> Call). It is constant
    time O(1).
3.  **Simplicity**: The compiler logic is straightforward. Classes remain simple
    structs without extra overhead if they don't use interfaces.
4.  **Decoupling**: The object layout is independent of the interfaces it
    implements.

### Trade-offs

1.  **Allocation**: Converting an object to an interface requires allocating the
    wrapper struct.
    - _Mitigation_: In the future, we can "explode" the fat pointer into two
      separate locals/arguments when passing it around on the stack, avoiding
      allocation until it's stored in a heap object (like an Array or Field).
2.  **Indirection**: Interface calls have one level of indirection more than
    virtual class calls.

## 5. Future Optimizations

- **Exploded Tuples**: Pass `$instance` and `$vtable` as separate arguments to
  functions to avoid allocating the wrapper struct for local usage.
- **Inline Caching**: If WASM adds support, we could optimize repeated calls.
