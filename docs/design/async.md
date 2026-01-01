# Async Programming & Concurrency Design

This document outlines the strategy for implementing asynchronous programming (`async`/`await`) and concurrency in Zena.

## 1. Async/Await Implementation

### The Problem
Implementing `async`/`await` in a language targeting WebAssembly is challenging because WASM (currently) does not have native support for suspending and resuming execution stacks (coroutines) in the core spec.

Traditional approaches (like C# or TypeScript targeting ES5) involve **State Machine Lowering**:
- The compiler rewrites every `async` function into a state machine struct.
- Local variables become fields in the struct.
- Control flow is managed by a `step()` method.

**Drawbacks for Zena**:
- **Complexity**: High implementation cost for the compiler.
- **Binary Size**: Generates significant boilerplate code, violating our "Minimal Output" principle.
- **Performance**: State machines can be slower than native stack switching.

### The Solution: WASM Stack Switching (Continuations)

We should target the **WASM Stack Switching** proposal (specifically Typed Continuations). This provides the low-level primitives (`suspend`, `resume`, `cont.new`) to implement coroutines and async/await efficiently without state-machine lowering.

However, the implementation strategy depends on the host:

#### 1. JavaScript Hosts (Browser/Node) -> JSPI
For environments with JavaScript, we should use the **JavaScript Promise Integration (JSPI)** API.
- **Mechanism**: Wraps WASM exports/imports to handle the suspension automatically.
- **Benefit**: Seamless interop with JS Promises. The JS engine manages the event loop and suspension.

#### 2. Standalone Hosts (WASI) -> Core Stack Switching
For standalone environments (like `wasmtime` or embedded), we cannot rely on JSPI.
- **Mechanism**: We must use the core **Stack Switching** instructions directly.
- **Requirement**: This requires Zena to implement its own **Async Runtime** (Scheduler) to manage the suspended stacks (continuations).

### Recommendation
**Design for the Core Stack Switching model.**

- The compiler should treat `async` functions as functions that can suspend.
- **Backend Divergence**:
  - **JS Target**: Emits JSPI-compatible wrappers.
  - **WASI Target**: Emits code that yields a continuation to a Zena-implemented scheduler.

### Proposed Syntax

```zena
// Returns a Promise<string> (or Zena equivalent wrapper)
async const fetchUser = (id: i32): string => {
  // 'await' suspends the stack
  const response = await fetch(`https://api.example.com/users/${id}`);
  return response.text();
}
```

## 2. The Event Loop

**Q: Do we need an event loop?**
**A: It depends on the target.**

### Browser/Node (JSPI)
**No.** We delegate to the host's JS Event Loop. Zena code runs on the V8 stack and suspends via JSPI.

### Standalone (WASI / Core Stack Switching)
**Yes.**
Since there is no JS engine to drive the promises, Zena must include a minimal **Async Runtime** in its standard library for standalone builds.

- **Scheduler**: A simple queue of ready continuations.
- **Reactor**: A mechanism to poll the host (via WASI `poll_oneoff` or similar) for I/O events and wake up the corresponding continuations.

**Decision**:
- **Compiler**: Agnostic. Generates code that suspends.
- **Runtime**:
  - `zena-js`: Thin wrapper around JSPI.
  - `zena-wasi`: Includes a Scheduler and Event Loop.

## 3. Threads & Concurrency

### WASM Threads (Shared Memory)
WASM Threads currently rely on `SharedArrayBuffer` and `atomics`.
- **Limitation**: You cannot share **WASM GC objects** (structs, arrays) between threads. They are thread-local.
- **Future**: The "Shared-Everything" or "Shared-Structs" proposal is exploring sharing GC objects, but it is far off.

### Safer Concurrency Constructs

Since we cannot easily share memory (GC objects), we should embrace **Share-Nothing Concurrency** (Actors / Isolates).

#### 1. Isolates (Web Workers)
Each thread runs a separate instance of the Zena runtime/module.
- **Communication**: Message passing (copying data).
- **Safety**: No data races by definition.

#### 2. Structured Concurrency
When we do have `async`/`await`, we should enforce **Structured Concurrency**.
- Spawning a task should be bound to a scope.
- If the scope exits, all child tasks are awaited or cancelled.

```zena
// Hypothetical syntax
await scope((s) => {
  s.spawn(() => task1());
  s.spawn(() => task2());
  // Implicitly awaits both before exiting block
});
```

#### 3. Channels
If we use Threads/Workers, we should provide typed **Channels** for communication, similar to Go or Rust.

```zena
const ch = new Channel<i32>();
spawn(() => {
  ch.send(1);
});
const val = await ch.receive();
```

## Roadmap

1.  **Phase 1 (Now)**:
    - No native `async`/`await`.
    - Use callbacks or raw Promises via Host Interop if needed.
2.  **Phase 2 (Experimental - JSPI)**:
    - Enable JSPI flags in test runner.
    - Implement `async` keyword which compiles to a "suspending" function signature.
    - Implement `await` which calls the suspending import.
3.  **Phase 3 (Standalone Support)**:
    - Implement the **Async Runtime** (Scheduler) in Zena.
    - Implement `async` compilation using Core Stack Switching instructions (`suspend`, `resume`).
    - Integrate with WASI poll interface.
4.  **Phase 4 (Standard)**:
    - Expose full `async`/`await` support across all targets.
    - Build `Task` and `Channel` libraries.
