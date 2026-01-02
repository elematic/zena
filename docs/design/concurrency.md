# Concurrency & Async Design

This document outlines the strategy for concurrency (managing multiple tasks) and parallelism (simultaneous execution) in Zena.

## 1. Philosophy

Zena aims to provide a concurrency model that is **safe**, **performant**, and **compatible** with the WebAssembly ecosystem.

1.  **Safety**: Prevent data races by design.
2.  **WASM-Native**: Align with WASM's threading and stack-switching capabilities.
3.  **Structured**: Prefer structured concurrency over "fire-and-forget".

## 2. Single-Threaded Concurrency (Async/Coroutines)

For I/O-bound tasks and cooperative multitasking within a single thread, Zena uses **Async/Await**.

### Implementation: Stack Switching (Typed Continuations)
Instead of compiling `async` functions to state machines (like JS/C#), Zena leverages the **WASM Stack Switching** proposal (Typed Continuations). This provides low-level instructions (`cont.new`, `suspend`, `resume`) to pause and resume execution stacks without host-specific "magic".

**Host Integration Strategies:**

1.  **JavaScript Hosts (JSPI)**:
    The **JavaScript Promise Integration (JSPI)** proposal is a high-level API built *on top* of stack switching concepts specifically for JS embeddings. It allows WASM to suspend when calling an async JS import.
    *   *Compiler Strategy*: Zena emits standard functions but wraps imports/exports with `WebAssembly.Suspending` / `WebAssembly.promising`.

2.  **Standalone Hosts (Core Stack Switching)**:
    For environments without JavaScript (e.g., pure WASI), Zena uses the core instructions directly.
    *   *Compiler Strategy*: Zena emits `suspend` instructions and implements a **Scheduler** in the runtime to manage continuations (`cont.bind`, `resume`).

### Syntax
```zena
const fetchData = async (url: string) => {
  const data = await http.get(url); // Suspends stack
  return data;
}
```

### The Future Class
We will introduce a standard library class `Future<T>` (wrapping JS Promises on JS hosts).

#### Naming: Future vs Promise vs Task
We chose the name **`Future`** after considering the landscape:

*   **JavaScript/TypeScript (`Promise`)**: While Zena syntax is TS-like, JS `Promise` has specific behaviors (auto-flattening, "thenables") that we explicitly reject. Using the name `Promise` would invite confusion ("Why doesn't my Zena Promise behave like a JS Promise?").
*   **C# (`Task`)**: `Task` implies a unit of work being executed. While accurate, it often conflates the *job* with the *result*.
*   **Rust/C++/Java/Dart (`Future`)**: This is the standard term in systems and strongly-typed languages for "a value that will be available later".
    *   *Note on Java*: In Java, `Future.get()` blocks the OS thread. In Zena (like Dart or Rust), `Future` is designed to be `await`-ed (suspending the task, not the thread).
        *   **Blocking vs Suspension**: `await` suspends the *task* (stack switching), allowing the thread to do other work. `get()` would block the *thread*.
        *   **Deadlock Risk**: Blocking the thread on a Future belonging to the same thread causes a deadlock (the thread cannot run the event loop to resolve the Future).
        *   **Worker Threads**: While worker threads *can* block (unlike the main thread), we avoid exposing blocking APIs for Futures to prevent accidental deadlocks. Use `await` everywhere.

**Decision**: Use **`Future`**.
*   It signals **Monadic** behavior (standard in functional/systems languages).
*   It avoids the "baggage" of JS Promises.
*   It aligns with the "Systems" aspect of Zena (WASM-GC).

**Design Decisions vs JavaScript:**
1.  **Final**: The class is `final`. Subclassing Promises is a known source of complexity and performance issues.
2.  **No "Thenables"**: `await` only accepts `Future<T>`. We do not support duck-typed "thenables". This avoids runtime overhead and ambiguous behavior.
3.  **No Auto-Flattening (Monadic)**: `Future<Future<T>>` is distinct from `Future<T>`.
    *   **JS Promises are Non-Monadic**: JS conflates `map` and `flatMap` into `.then()`, and recursively unwraps values. This prevents representing `Promise<Promise<T>>`, violating strict monad laws.
    *   **Zena Futures are Monadic**: We strictly distinguish between `map` (transform value) and `flatMap` (chain async operation). This ensures `Future<T>` behaves consistently for *any* `T`.
    *   *Optimization*: The compiler can still optimize tail-calls (returning a Future from an async function) without merging the types.
4.  **Typed**: `Future<T>` is strictly typed.

```zena
// No auto-flattening
let nested: Future<Future<i32>> = ...;
let inner: Future<i32> = await nested; 
let val: i32 = await inner;
```

## 3. Parallelism (Multi-Threading)

Parallelism involves running code on multiple threads (Web Workers / WASM Threads).

### The Constraint: WASM GC
Currently, **WASM GC objects (Structs, Arrays) are thread-local**. They cannot be shared between threads. Only linear memory (`SharedArrayBuffer`) can be shared.
*Future*: The "Shared-Structs" proposal will allow sharing GC objects, but we must design for today's constraints while preparing for the future.

### Model A: Isolates (Share-Nothing)
This is the default model for Zena (similar to Web Workers or Erlang).
-   **Mechanism**: Each thread is an **Isolate** with its own heap.
-   **Communication**: Message passing (copying data).
-   **Safety**: 100% safe. No data races because memory is not shared.

### Model B: Shared Memory (Advanced)
To support high-performance scenarios, we need shared memory.

#### 1. Shared Immutable Data
Once WASM supports Shared-Structs, Zena will allow sharing **Deeply Immutable** data.
-   `const` data structures that contain no mutable fields.
-   Safe to read from multiple threads without locks.

#### 2. Ownership Transfer (Fork/Join)
To safely share mutable data without locks, we can use **Ownership Transfer**.
-   **Concept**: When you send a mutable object (like a buffer) to another thread, the sender "loses" access to it.
-   **Implementation**: Relies on "Transferable" semantics (like `ArrayBuffer.transfer` in JS).
-   **Syntax**:
    ```zena
    let buffer = new SharedBuffer(1024);
    // 'move' keyword or implicit flow analysis ensures 'buffer' 
    // cannot be used here after sending.
    channel.send(move buffer); 
    ```

#### 3. Explicit Locking (Monitors / RWLocks)
For shared mutable state that cannot be transferred, we use **Monitors** or **Read-Write Locks**.
-   **Special Allocation**: Shared objects must be allocated in a `shared` heap (SharedArrayBuffer).
-   **Access Control**: The compiler **enforces** that mutable fields of a `shared` class are only accessible inside a lock block.
    -   `read_lock (this)`: Allows **reading** mutable fields. Multiple threads can hold a read lock simultaneously.
    -   `write_lock (this)` (or just `lock`): Allows **reading and writing**. Only one thread can hold a write lock (exclusive).

```zena
// Hypothetical Shared Class
shared class Counter {
  #count: i32 = 0;
  
  get() {
    read_lock (this) {
      return this.#count; // OK: Read allowed
    }
  }

  increment() {
    write_lock (this) {
      this.#count += 1; // OK: Write allowed
    }
  }
}
```

**Design Note: The "Java Monitor" Problem**
A common criticism of Java's `synchronized(this)` is that it exposes the lock to the public. External code can lock on your object, potentially causing deadlocks or performance issues (Denial of Service).
*   **Zena's Approach**:
    1.  **Opt-in Overhead**: Unlike Java, where *every* object has a monitor (memory overhead), Zena only allocates monitors for `shared` classes.
    2.  **Encapsulation**: While `lock(this)` is convenient, Zena also supports locking on private fields (e.g., `#mu = new Mutex(); lock(this.#mu) { ... }`). This is recommended for library code to prevent external interference.

## 4. Synchronization Primitives

### Channels
Channels are typed pipes for communication between threads (Isolates).

**The "Go Race" Problem**: In Go, channels are synchronized, but if you send a pointer to mutable data, both threads can race on that data.

**Zena's Solution**: Enforce **Send Safety**.
The type system checks that data sent over a channel is either:
1.  **Value Type** (i32, f64) - Copied.
2.  **Deeply Immutable** - Safe to share.
3.  **Transferable** - Ownership moves (sender loses access).
4.  **Shared Object** - Thread-safe (handles its own locking).

Standard mutable GC objects (like `class Point { var x: i32; }`) **cannot** be sent over channels.

```zena
const ch = new Channel<ImmutableData>();
spawn(() => {
  ch.send(new ImmutableData(42));
});
```

### Structured Concurrency
We enforce structured lifecycles for tasks using `using` (Explicit Resource Management).

```zena
{
  // 'using' ensures the task is awaited/cancelled when scope exits
  using task = spawn(() => process());
}
```

## 5. Roadmap

1.  **Phase 1: Async (Single Thread)**
    -   Implement `async`/`await` via JSPI.
2.  **Phase 2: Isolates**
    -   Implement `spawn` using Web Workers / WASM Threads.
    -   Implement message passing (copying semantics).
3.  **Phase 3: Safe Sharing**
    -   Implement `Channel<T>` with `Send` checks.
    -   Implement `SharedArrayBuffer` wrappers.
4.  **Phase 4: Shared GC (Future)**
    -   Support WASM Shared-Structs when available.
    -   Implement `shared class` and locking mechanisms.
