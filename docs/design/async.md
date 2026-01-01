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

### The Solution: WASM Stack Switching (JSPI)

We should target the **JavaScript Promise Integration (JSPI)** proposal (also known as Stack Switching).

- **How it works**: It allows a WebAssembly module to import a JavaScript function that returns a Promise, and "suspend" the WASM execution when that function is called. When the Promise resolves, the WASM execution resumes.
- **Benefit**: Zena code looks synchronous and uses the native WASM stack. No compiler rewriting is required.
- **Status**: Currently in Phase 3 (Implementation). Available in V8 (Chrome/Node) behind flags.

### Recommendation
**We should wait for (or experimentally target) WASM Stack Switching.**

Implementing a full state-machine transformation now would be a massive effort that would likely be obsoleted by the platform shortly.

### Proposed Syntax

```zena
// Returns a Promise<string> (or Zena equivalent wrapper)
async const fetchUser = (id: i32): string => {
  // 'await' suspends the stack via JSPI
  const response = await fetch(`https://api.example.com/users/${id}`);
  return response.text();
}
```

## 2. The Event Loop

**Q: Do we need an event loop first?**
**A: No.**

Since Zena primarily targets host environments that already possess an event loop (Browsers, Node.js, Cloudflare Workers), we should **delegate to the host**.

- **Browser/Node**: The JS Event Loop drives execution. Zena code runs on the V8 stack.
- **WASI**: When targeting standalone WASI, we would rely on the WASI async poll interface (WASI Preview 2), which provides an event-loop-like mechanism.

**Decision**: Zena does not implement its own scheduler or event loop. It is a guest language.

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
2.  **Phase 2 (Experimental)**:
    - Enable JSPI flags in test runner.
    - Implement `async` keyword which compiles to a "suspending" function signature in the WASM Type Section.
    - Implement `await` which calls the suspending import.
3.  **Phase 3 (Standard)**:
    - Once JSPI is standard, expose full `async`/`await` support.
    - Build `Task` and `Channel` libraries.
