# Concurrency Design for Zena

This document explores concurrency models for Zena, analyzing WASI P3's cooperative threading, JS-style async/await, and web host support via JSPI.

## Design Decision: Stackless-Only

Zena uses **stackless async** (CPS/state machine transformation) exclusively:

| Approach | Memory per Task | Scales to 1000s | Requires 🚟 | Implementation |
|----------|-----------------|-----------------|-------------|----------------|
| Stackful | 64KB+ (full stack) | ❌ Poor | Yes | Simple codegen |
| **Stackless** | **~bytes (live vars only)** | **✅ Excellent** | **No** | **CPS transform** |

**Rationale**: UI frameworks with large component trees (1000s of awaiting components) cannot afford 64KB per suspended task. The CPS transform is table-stakes for modern async; once implemented, stackful offers no benefit.

---

## WASI P3 Cooperative Threading Summary

WASI P3 introduces **cooperative green threads** that switch only at explicit program points (not preemptively). Key capabilities:

### Thread Built-ins
| Built-in | Description |
|----------|-------------|
| `thread.new-indirect` | Creates a new suspended thread |
| `thread.resume-later` | Resumes a suspended thread non-deterministically later |
| `thread.yield-to` | Switch to given thread immediately, current resumed later |
| `thread.switch-to` | Switch to given thread immediately, current left suspended |
| `thread.suspend` | Explicitly suspend current thread |
| `thread.yield` | Allow runtime to switch execution |

### Stackless Async ABI

The stackless ABI uses a **callback pattern**:

1. Export function returns status code (`EXIT`, `YIELD`, `WAIT`)
2. Runtime calls companion `callback` function when events occur
3. Callback returns next status code
4. Repeat until `EXIT`

This maps directly to our CPS-transformed code.

### Key Primitives
- **Waitable sets**: epoll-like mechanism to wait on multiple concurrent operations
- **Futures/Streams**: Unidirectional unbuffered channels with session types
- **Backpressure**: Built-in mechanism to control concurrent export call admission

---

## JS-Style Async/Await Mapping

### Source Language

```zena
// async function type
const fetch = async (url: string) => Response;

// Call from async context - direct await
const doWork = async () => {
  let resp = await fetch("...");  // suspends if needed
  return resp;
};

// Call from sync context - returns Future<T>
const main = () => {
  let fut = fetch("...");  // Returns Future<Response>
  // fut.await() or explicit handling needed
};
```

### CPS Transformation

Each `async` function is transformed into a state machine:

```zena
// Source
const fetchUser = async (id: i32) => User {
  let token = await getToken();      // await 1
  let resp = await fetch(token, id); // await 2
  return resp.user;
};
```

**Transforms to** (conceptual WASM):

```wasm
;; State struct - only stores live variables at each await point
(type $fetchUser_state (struct
  (field $stage i32)      ;; which await we resumed from
  (field $id i32)         ;; captured param (live across all stages)
  (field $token Token)    ;; live after await 1
  (field $resp Response)  ;; live after await 2
  (field $waitable_set i32)
))

;; Entry point - returns i32 status code
(func $fetchUser (param $id i32) (result i32)
  ;; 1. Allocate state struct, store $id
  ;; 2. Create waitable set
  ;; 3. Call getToken (async import)
  ;; 4. If blocked: return (WAIT | waitable_set_index << 4)
  ;; 5. If immediate: store token, continue to stage 1...
)

;; Callback - called by runtime when waitable has event
(func $fetchUser_cb (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
  ;; Load state, switch on $stage:
  ;; 
  ;; Stage 0 (getToken completed):
  ;;   - Store token in state
  ;;   - Call fetch(token, id) async
  ;;   - Return WAIT or continue
  ;;
  ;; Stage 1 (fetch completed):
  ;;   - Extract resp.user
  ;;   - Call task.return with result
  ;;   - Return EXIT (0)
)
```

### Memory Efficiency

```
1000 suspended UI components:

Stackful:  1000 × 64KB = 64MB minimum
Stackless: 1000 × ~32B = 32KB typical (just state structs)
```

### Control Flow Across Await

The CPS transform handles all control flow constructs:

| Construct | Handling |
|-----------|----------|
| Sequential | State machine stages |
| `if/else` | Branches within stage, or split stages |
| `while` | Loop state in struct, re-enter same stage |
| `for-in` | Iterator state preserved |
| `try/catch` | Handler state tracked, jump to catch stage on error |
| `match` | Arms become stages if they contain await |

### Open Questions

1. **Fire-and-forget**: Should `async fn()` from sync context require explicit handling?
2. **Implicit await**: Should function call to async fn from async fn auto-await?
3. **Future combinators**: `Future.all()`, `Future.race()`?

---

## Web Host Support: JSPI

[JavaScript Promise Integration (JSPI)](https://github.com/WebAssembly/js-promise-integration/) enables async interop between WASM and JS without WASI P3.

### How JSPI Works

```javascript
// JS side: wrap WASM for Promise support
const instance = await WebAssembly.instantiate(module, {
  env: {
    // Wrap JS async function for WASM to call
    fetch: WebAssembly.suspending(async (urlPtr, urlLen) => {
      const url = decodeString(urlPtr, urlLen);
      const resp = await fetch(url);
      return encodeResponse(resp);
    })
  }
});

// Wrap WASM export to return Promise
const asyncExport = WebAssembly.promising(instance.exports.doWork);
const result = await asyncExport(args);
```

When WASM calls a `suspending` import:
1. JS engine suspends the WASM stack
2. Promise proceeds through JS event loop
3. When Promise resolves, WASM stack resumes
4. WASM receives the result synchronously (from its perspective)

### JSPI vs WASI P3 Comparison

| Feature | JSPI | WASI P3 |
|---------|------|---------|
| Host | Browser/JS only | Any WASI runtime |
| Stack management | JS engine handles | Runtime handles |
| Concurrency primitives | Via JS (Promise.all, etc.) | Built-in (waitable sets, streams) |
| Multiple concurrent awaits | Multiple `promising` calls | Single callback handles all |

### Dual-Target Strategy

Our CPS transform works for **both** targets:

```
                    ┌─────────────────────────────────────┐
                    │       Zena async function          │
                    │                                     │
                    │  const f = async () => {           │
                    │    let x = await a();              │
                    │    let y = await b(x);             │
                    │    return y;                       │
                    │  };                                │
                    └──────────────┬──────────────────────┘
                                   │
                         CPS Transform
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
              ▼                                         ▼
┌─────────────────────────────┐         ┌─────────────────────────────┐
│       WASI P3 Target        │         │       JSPI Target           │
│                             │         │                             │
│  • Export: entry + callback │         │  • Export: linear function  │
│  • Return WAIT/EXIT codes   │         │  • Rely on suspending import│
│  • waitable-set management  │         │  • JS handles suspension    │
│                             │         │                             │
│  (func $f (result i32) ...) │         │  (func $f (result i32)      │
│  (func $f_cb (...) ...)     │         │    call $a  ;; suspends     │
│                             │         │    call $b  ;; suspends     │
│                             │         │    return)                  │
└─────────────────────────────┘         └─────────────────────────────┘
```

**Key insight**: For JSPI, if every `await` is just an import call, we can emit **simpler linear code** without explicit state machines—JSPI handles the suspension. But this only works when:
- All awaited values come from JS imports
- No need for concurrent spawning within WASM

For full generality (spawn, join, select, internal futures), we use the CPS approach regardless of target.

### JSPI's Critical Limitation: One Stack per Export

**JSPI suspends the entire WASM stack.** There's no mechanism to yield to another internal task.

```javascript
// From JS: TWO separate stacks, can run concurrently ✅
const p1 = wasmExport1();  // Creates suspendable stack 1
const p2 = wasmExport2();  // Creates suspendable stack 2
await Promise.all([p1, p2]);  // Both in flight
```

```wasm
;; From WASM: ONE stack, sequential ❌
call $fetch1  ;; Suspends entire stack... waits for response
call $fetch2  ;; Can't start until $fetch1 completes!
```

This breaks concurrent patterns:

```zena
const loadBoth = async () => {
  let f1 = fetch(url1);  // Want to start fetch 1
  let f2 = fetch(url2);  // Want to start fetch 2 concurrently
  return (await f1, await f2);
};
```

**With naive JSPI codegen** (sequential, slow):
```
call fetch(url1)  → suspend → wait 500ms → resume
call fetch(url2)  → suspend → wait 500ms → resume
Total: 1000ms
```

**What we want** (concurrent, fast):
```
Start fetch(url1) → Start fetch(url2) → wait ~500ms → both ready
Total: ~500ms
```

### Solution: CPS + JS Event Loop Orchestration

For functions with potential concurrent awaits, we use CPS and return control to JS between await points. This mirrors WASI P3's callback ABI, but orchestrated by JS.

```
┌─────────────────────────────────────────────────────────────┐
│  WASM calls to JS are NON-suspending                        │
│  They start async work and return a "task ID" immediately   │
│                                                              │
│  1. WASM calls startFetch(url1) → returns taskId 1          │
│  2. WASM calls startFetch(url2) → returns taskId 2          │
│  3. WASM returns to JS: "waiting on tasks [1, 2]"           │
│  4. JS does: await Promise.race([task1, task2])             │
│  5. JS calls WASM callback: "task 1 completed"              │
│  6. WASM updates state, returns: "still waiting on [2]"     │
│  7. JS awaits task 2, calls callback again                  │
│  8. WASM returns EXIT with final result                     │
└─────────────────────────────────────────────────────────────┘
```

**JS Runtime Sketch**:

```javascript
// JS runtime for Zena async on JSPI hosts
const pendingTasks = new Map();  // taskId -> Promise
let nextTaskId = 1;

const imports = {
  // Non-blocking: starts work, returns task ID immediately
  startFetch: (urlPtr, urlLen) => {
    const url = decodeString(urlPtr, urlLen);
    const taskId = nextTaskId++;
    pendingTasks.set(taskId, 
      fetch(url).then(r => ({ taskId, result: r }))
    );
    return taskId;
  },
  
  startTimeout: (ms) => {
    const taskId = nextTaskId++;
    pendingTasks.set(taskId, 
      sleep(ms).then(() => ({ taskId, result: null }))
    );
    return taskId;
  }
};

// Main loop - drives the WASM state machine
async function runAsync(wasmEntry, wasmCallback, ...args) {
  let status = wasmEntry(...args);
  
  while ((status & 0xF) !== 0) {  // Not EXIT
    if ((status & 0xF) === 2) {   // WAIT
      const taskIds = getWaitSet(status >> 4);
      const promises = taskIds.map(id => pendingTasks.get(id));
      
      // Race all pending tasks - first completion wins
      const { taskId, result } = await Promise.race(promises);
      pendingTasks.delete(taskId);
      
      // Resume WASM with completed task info
      status = wasmCallback(taskId, encodeResult(result));
    }
  }
  
  return getResult();  // Extract final return value
}
```

### Codegen Strategy Decision Tree

| Scenario | Detection | Codegen |
|----------|-----------|---------|
| Sequential awaits only | All awaits in sequence, no spawn | JSPI linear (optimization) |
| Multiple concurrent awaits | `spawn`, multiple `await` on futures | CPS + JS loop |
| TaskGroup / structured | Uses `TaskGroup`, `spawn` | CPS + JS loop |
| Internal futures | Creates `Future<T>` values | CPS + JS loop |

**Implementation**: Always generate CPS. Apply JSPI linearization as an **optimization pass** for simple cases.

### Alternative: Delegate All Concurrency to JS

Simpler but less flexible approach:

```zena
// Zena - explicit JS delegation
const loadBoth = async (url1: string, url2: string) => (Response, Response) {
  return await promiseAll2(fetch, url1, fetch, url2);
};
```

```javascript
// JS import handles concurrency
WebAssembly.suspending(async (fn1, arg1, fn2, arg2) => {
  return Promise.all([fn1(arg1), fn2(arg2)]);
})
```

**Tradeoff**: Works but couples Zena code to JS-specific patterns.

---

## Alternative Concurrency Models

### 1. Coroutines / Fibers (Cooperative Lightweight Threads)

Direct exposure of WASI P3's green thread primitives:

```zena
// Create a fiber
let fiber = Fiber.new(() => {
  // ... do work ...
  Fiber.yield();  // Explicitly yield
  // ... continue ...
});

// Resume fiber
fiber.resume();

// Symmetric coroutines
Fiber.switchTo(otherFiber);
```

**Pros**:
- Maximum control over scheduling
- Zero-overhead abstractions possible
- Familiar to Go/Lua/Ruby users

**Cons**:
- Low-level, error-prone
- No structured lifetime management
- Manual state coordination

**Use Case**: Game loops, state machines, interpreters

### 2. Structured Concurrency (Nurseries/Task Groups)

Ensure child tasks complete before parent:

```zena
// All tasks in nursery must complete before block exits
async with TaskGroup.new() as group {
  group.spawn(() => fetchUser(id));
  group.spawn(() => fetchPosts(id));
  // Block waits for both
}
// Both tasks guaranteed complete here

// With result collection
let results = async with TaskGroup.new() as group {
  let userTask = group.spawn(() => fetchUser(id));
  let postsTask = group.spawn(() => fetchPosts(id));
  yield (userTask.result, postsTask.result);
};
```

**Pros**:
- Eliminates leaked tasks
- Clear lifetime boundaries
- Natural error propagation (cancel siblings on failure)
- Matches mental model of "do A, B, C concurrently then continue"

**Cons**:
- Less flexible than unstructured spawning
- Some patterns harder (long-running background tasks)

**Note**: WASI P3 has *minimal* structured concurrency - supertasks "tail call" into subtasks when they finish, but don't strictly wait. Zena could enforce stricter semantics.

### 3. Channels (Stdlib, Not Language Feature)

CSP (Communicating Sequential Processes) via typed channels. Unlike Go, channels use **explicit `await`** for consistency with async/await:

```zena
// Create channel
let ch = Channel<i32>.new();

// In one task - explicit await
await ch.send(42);  // Suspends until receiver ready

// In another task - explicit await  
let val = await ch.recv();  // Suspends until value available

// Buffered channels - send doesn't suspend until buffer full
let bufCh = Channel<i32>.buffered(10);
await bufCh.send(1);  // Doesn't suspend (buffer has space)

// Non-blocking variants (no await needed)
if ch.trySend(42) { ... }      // Returns false if would block
if let val = ch.tryRecv() { ... }  // Returns null if empty

// Select - await on first ready channel
let result = await Channel.select(
  ch1.recv(),   // Future<i32>
  ch2.recv(),   // Future<string>
  timeout(100), // Future<void>
);
match result {
  case (0, val: i32) => handleVal(val),
  case (1, msg: string) => handleMsg(msg),
  case (2, _) => handleTimeout(),
}
```

**Design Rationale**: 
- **One rule**: `await` = suspension point. No implicit blocking.
- Channels are a **library type**, not language syntax.
- Same CPS compilation as any async code.

**Stdlib API**:
```zena
// zena:channels
class Channel<T> {
  static new() => Channel<T>;
  static buffered(capacity: i32) => Channel<T>;
  static select(...futures: array<Future<any>>) => async (i32, any);
  
  send(value: T) => async void;
  recv() => async T;
  
  trySend(value: T) => boolean;
  tryRecv() => T | null;
  
  close() => void;
  isClosed() => boolean;
}
```

**Mapping to WASI P3**: Channels implemented using:
- Internal queue + waitable for synchronization
- `waitable-set.wait` + `waitable-set.poll` for select

**Pros**:
- Consistent with async/await (no implicit blocking)
- Proven model (Go, Erlang/Elixir, Kotlin)
- Just a library, no special compiler support

**Cons**:
- Slightly more verbose than Go (`await ch.send(x)` vs `ch <- x`)
- Deadlock still possible

### 4. Actor Model

Isolated actors with message-passing:

```zena
actor Counter {
  var count = 0;
  
  receive Increment => { count = count + 1; }
  receive GetCount(replyTo: ActorRef<i32>) => { replyTo.send(count); }
}

// Create and use
let counter = spawn Counter;
counter.send(Increment);
counter.send(Increment);
let count = counter.ask(GetCount);  // ask = send + await response
```

**Pros**:
- Complete isolation (no shared mutable state)
- Location transparency (same API local or remote)
- Natural failure isolation

**Cons**:
- Verbose for simple cases
- Dead letters / undelivered messages
- Ordering complexities

### 5. Parallel Workers (Interim True Parallelism)

For actual parallel execution on multiple cores **today** (without shared-everything-threads):

```zena
// Worker pool for CPU-bound work
let pool = WorkerPool.new(cpuCount());

// Submit work - returns Future
let result = pool.submit(() => heavyComputation(data));

// Parallel map
let results = pool.map(items, (item) => process(item));

// Parallel reduce
let sum = pool.reduce(numbers, 0, (acc, n) => acc + n);
```

**Implementation**: Separate component instances with message passing.

**Limitations**:
- Serialization costs for complex data (structured clone)
- Can't share class instances without custom serialization
- Cumbersome API discourages use
- No way to share mutable state efficiently

**Use until**: WASM shared-everything-threads + GC enables true shared-memory (see below).

---

### 6. True Shared-Memory Parallelism (Future)

Once WASM shared-everything-threads supports GC objects, we can do better than workers. The goal: **share data safely without serialization overhead**.

#### Design Constraints

1. **Same-code threads**: Unlike web workers loading different scripts, Zena threads run the same compiled module. This enables:
   - Sending class instances (vtables are identical)
   - Sharing functions and closures
   - Type-safe transfer without serialization

2. **Data race freedom**: Must prevent:
   - Multiple writers to same object
   - Reader seeing partially-written state
   - Use-after-free across threads

3. **Practical ergonomics**: Better than "just use locks everywhere"

#### Approaches from Other Languages

**Rust: Ownership + Send/Sync traits**
```rust
// Send = can be transferred to another thread
// Sync = can be accessed from multiple threads (&T is Send)
// Borrow checker enforces at compile time
let data = Arc<Mutex<T>>;  // Shared mutable via explicit locking
```
*Pros*: Zero-cost abstractions, compile-time safety
*Cons*: Complex ownership system, steep learning curve

**Pony: Reference Capabilities**
```pony
// iso  = isolated (unique reference, can transfer)
// val  = deeply immutable (freely shareable)
// ref  = mutable (local only)
// box  = read-only view
// tag  = identity only (can't read fields)

let data: iso String = "hello"  // Unique owner
othertask.send(consume data)    // Transfer ownership
```
*Pros*: No data races by construction, no locks needed
*Cons*: Capabilities are viral, complex mental model

**Swift: Sendable + Actor Isolation**
```swift
// Sendable marks types safe to share
struct Point: Sendable { let x, y: Int }  // OK (immutable)
class Counter: Sendable { var count = 0 } // Error (mutable class)

actor Counter {
  var count = 0
  func increment() { count += 1 }  // Isolated mutation
}
```
*Pros*: Gradual adoption, familiar actor model
*Cons*: Actors have async overhead, isolation can be limiting

**Verona: Regions + Cowns**
```verona
// Cowns = Concurrent Owned objects (like actors but for data)
// Regionsmutual = group objects together for atomic access
when (cown1, cown2) {
  // Have exclusive access to both cown1 and cown2
}
```
*Pros*: Fine-grained ownership, deadlock-free by construction
*Cons*: Research language, complex runtime

#### Proposed Design for Zena

##### Core Concepts

**1. `frozen` Types (Deeply Immutable)**

```zena
// Deeply immutable - can be freely shared across threads
frozen class Config {
  host: string;
  port: i32;
}

// All fields must be frozen or primitive
frozen class ASTNode {
  kind: NodeKind;            // enum (frozen)
  children: frozen<array<ASTNode>>;  // frozen array
  span: Span;                // frozen record type
}

// Mutable class can be frozen after construction
var tree = MutableTree.new();
buildTree(tree);
let frozenTree = tree.freeze();  // Consumes tree, returns frozen
// tree is now inaccessible (moved)
```

**Compiler enforcement**:
- `frozen` types can only contain `frozen` or primitive fields
- Frozen values can be freely shared (no locking needed)
- Parse trees, type representations, IR nodes are natural fits

**2. `isolated` References (Unique Ownership)**

```zena
// isolated = unique reference, can be transferred between threads
let node: isolated<Node> = Node.new();

// Transfer ownership to another thread
spawn move(node) {
  // This thread now exclusively owns node
  node.mutate();
};
// Error: node has been moved

// isolated can be "opened" for local use
let node: isolated<Node> = Node.new();
let local: Node = node.open();  // Consumes isolated wrapper
local.mutate();                 // Full local access
// But can't transfer local anymore
```

**3. Scoped Parallel Borrowing**

```zena
// Borrow mutable data to parallel tasks for scope duration
let tree = Tree.new();

parallel.scope((scope) => {
  for child in tree.children {
    // Borrow each child exclusively to a task
    scope.spawn(borrow child) {
      processSubtree(child);  // Exclusive mutable access
    };
  }
});
// Scope ends: all borrows returned, tree fully accessible

// Read-only parallel access
parallel.scope((scope) => {
  let treeRef = tree.readOnly();  // Shared read-only view
  for i in 0..numWorkers {
    scope.spawn(share treeRef) {
      analyze(treeRef);  // Multiple readers OK
    };
  }
});
```

**Scope guarantees**:
- Borrowed data cannot escape the scope
- Scope blocks until all tasks complete
- Compiler verifies borrow exclusivity

**4. Regions (Object Graph Ownership)**

Regions group related objects so they can be transferred or frozen as a unit.

**Core Insight: Regions as Runtime Context**

Region allocation must flow through the **entire call graph**, not just direct `new` expressions. This is the same pattern as tracing context (see [Context Parameters](context-parameters.md)):

```zena
let region = new Region(sendable () => {
  let root = new Node(1, null);     // Allocates in region
  let child = createNode(2);        // Also allocates in region!
  root.children = #[child];
  return root;
});

// This helper function doesn't know about regions
const createNode = (value: i32) => new Node(value, null);
// But when called from a region callback, its `new` allocates in that region
```

**How it works** (runtime context):

```zena
// Conceptual: there's a runtime "current region" context
// (similar to TracerContext in context-parameters.md)
let RegionContext = createContext<Region?>(null);

// Every `new Foo(...)` implicitly checks the context:
//   if RegionContext.current() != null:
//     allocate in that region
//   else:
//     allocate on default heap

// Region.new() sets the context for the duration of the callback:
class Region<T> {
  static new<T>(init: sendable () => T) => Region<T> {
    let region = allocateRegion();
    let root = RegionContext.with(region, init);
    return Region { root };
  }
}
```

**Why context, not pattern-matching?**

Pattern-matching `new Region(sendable () => { new Foo() })` can't handle:
- Helper functions called from the callback
- Constructor logic that creates other objects
- Library code that allocates internally

Context propagation handles all of these automatically.

**Sendable Classes**

For a class to be usable in regions (and threads), it must be **Sendable**:

```zena
// Automatically Sendable: no mutable captures, all fields Sendable
class Node {
  value: i32;
  children: array<Node>;
  parent: Node | null;
  
  #new(value: i32, parent: Node | null) {
    this.value = value;
    this.parent = parent;
    this.children = #[];
  }
}

// NOT Sendable: constructor captures mutable global
var globalCounter = 0;

class CountedNode {
  id: i32;
  
  #new() {
    this.id = globalCounter;
    globalCounter = globalCounter + 1;  // Mutates external state!
  }
}
// Error: CountedNode is not Sendable because #new captures mutable 'globalCounter'
```

**Sendable class rules** (statically checked):

1. **Constructor purity**: `#new` can't read or write mutable variables from enclosing scope
2. **Field types**: All fields must be Sendable types (or `frozen`, or primitives)
3. **Method purity**: Methods called during construction follow same rules
4. **No mutable statics**: Class can't have mutable static fields

```zena
// Static checking example
var badGlobal = 0;

class Foo {
  x: i32;
  
  #new() {
    this.x = badGlobal;  // Error: reading mutable 'badGlobal' in Sendable class
    badGlobal = 1;       // Error: writing mutable 'badGlobal' in Sendable class
    this.helper();       // Checked transitively
  }
  
  helper() {
    badGlobal = 2;       // Error: Foo.helper() captures mutable state
  }
}
```

**Why static checking works**: The compiler already does capture analysis for closures. Extending this to class constructors is straightforward - treat `#new` like a closure and verify it captures no mutable external state.

**Explicit Sendable annotation** (optional, for documentation):

```zena
sendable class Node {  // Explicit: compiler verifies Sendable rules
  value: i32;
  #new(value: i32) { this.value = value; }
}

class MaybeNotSendable {  // Implicit: compiler infers Sendability
  // ...
}
```

**What about classes that need initialization state?**

Pass it as constructor parameters, not via closure capture:

```zena
// BAD: captures config from closure
let config = loadConfig();
class Handler {
  #new() {
    this.timeout = config.timeout;  // Error: captures 'config'
  }
}

// GOOD: explicit parameter
class Handler {
  timeout: i32;
  #new(config: Config) {  // Config must be Sendable or frozen
    this.timeout = config.timeout;
  }
}

let region = new Region(sendable () => {
  let config = loadConfig();  // Allocated in region too!
  new Handler(config)
});
```

**Nested regions**:

```zena
let outer = new Region(sendable () => {
  let node1 = new Node(1, null);  // In outer region
  
  let inner = new Region(sendable () => {
    let node2 = new Node(2, null);  // In inner region
    return node2;
  });
  
  // inner is a Region<Node> allocated in outer region
  // inner.root points to node2/inner region's objects
  
  return { node1, inner };
});
```

The context stack handles nesting naturally - `new Region()` pushes a new context, callback runs, context pops.

**Interaction with frozen**:

```zena
let config: frozen<Config> = ...;  // Frozen = world-readable

let region = new Region(sendable () => {
  // OK: frozen values can be referenced from anywhere
  let node = new Node(1, config);  // config is not copied into region
  
  // OK: primitives are values (copied)
  let x = 42;
  let node2 = new Node(x, null);
  
  // OK: records are value types (copied)
  let span = { start: 0, end: 10 };
  let node3 = new Node(3, span);
  
  return node;
});
```

**Comparison to explicit allocator approach**:

| Aspect | Runtime Context | Explicit Allocator |
|--------|-----------------|-------------------|
| Helper functions | ✅ Just work | ❌ Must pass allocator |
| Existing code | ✅ Works in regions | ❌ Must be rewritten |
| Clarity | ⚠️ "Magic" allocation | ✅ Explicit |
| Nested regions | ✅ Context stack | ✅ Different allocator names |
| Performance | Small overhead (context check) | Zero overhead |

**Recommendation**: Runtime context. The ergonomic benefits outweigh the small runtime cost. Code that doesn't know about regions "just works" when called from a region context.

**Adding objects after construction**:

```zena
// extend() enters region context again
region.extend(sendable () => {
  let newNode = new Node(4, region.root);
  region.root.children.push(newNode);
});

// Alternative: MutableRegion that stays "open"
let region = new MutableRegion(sendable () => new Node(1, null));
region.run(sendable () => {
  let child = new Node(2, region.root);
  region.root.children.push(child);
});
let sealed: Region<Node> = region.seal();
  region.root.children.push(child);
});
// Seal when done
let sealed: Region<Node> = region.seal();
```

**Region rules**:
- Objects are *born* in regions via `self.alloc()`, not moved in
- Region objects can reference: other same-region objects, frozen objects, primitives
- External code accesses region via `region.root` (the root object)
- Transfer region = transfer all contained objects atomically
- Freeze region = freeze all contained objects, return frozen root

##### Compiler Use Case: Parallel Compilation

```zena
// Phase 1: Parse (embarrassingly parallel, isolated results)
let asts: array<isolated<AST>> = parallel.map(files, (file) => {
  isolated(parseFile(file))  // Wrap result as isolated
});

// Phase 2: Local analysis (parallel, each AST isolated)
let modules: array<isolated<Module>> = parallel.map(asts, (ast) => {
  isolate {
    let module = analyzeLocal(ast.open());
    isolated(module)
  }
});

// Phase 3: Cross-module resolution (need shared read access)
let frozenModules = modules.map(m => m.open().freeze());
// All modules are now frozen, can be freely shared

parallel.scope((scope) => {
  for module in frozenModules {
    scope.spawn(share frozenModules) {
      // Read all modules, build cross-references
      resolveCrossReferences(module, frozenModules);
    };
  }
});

// Phase 4: Type checking (parallel, partition by strongly-connected components)
let sccs = computeSCCs(frozenModules);
for scc in sccs {
  if scc.len() == 1 {
    // Single module, can process in parallel with others
    parallel.spawn(() => typeCheck(scc[0]));
  } else {
    // Mutually recursive modules, process together
    typeCheckGroup(scc);
  }
}

// Phase 5: Codegen (embarrassingly parallel, read frozen IR)
let wasmModules = parallel.map(frozenModules, generateCode);
```

##### Type System Integration

```zena
// Sendable trait - can cross thread boundaries
interface Sendable { }

// Automatically Sendable:
// - Primitives (i32, f64, boolean, etc.)
// - frozen types
// - isolated references
// - Records/tuples of Sendable types

// Not Sendable:
// - Mutable classes (unless wrapped in isolated)
// - Closures capturing non-Sendable state

// spawn requires Sendable arguments
const processData = (data: isolated<Data>) => {
  spawn move(data) {  // data is Sendable (isolated)
    ...
  };
};

const broken = (data: Data) => {
  spawn {
    data.mutate();  // Error: Data is not Sendable
  };
};
```

##### Sendable Closures

A closure that only captures `Sendable` values is itself `Sendable`. But checking this at call sites can lead to confusing errors. An explicit **sendable closure** syntax makes intent clear:

**Option 1: `sendable` keyword on closure**

```zena
// Explicit sendable closure - compiler enforces capture restrictions
let mapper = sendable (x: i32) => x * 2;  // OK: no captures

var counter = 0;
let broken = sendable (x: i32) => {
  counter = counter + 1;  // Error: cannot capture mutable 'counter' in sendable closure
  x * 2
};

// Can capture frozen/immutable values
let config: frozen<Config> = ...;
let processor = sendable (x: Data) => process(x, config);  // OK: config is frozen
```

**Option 2: Inferred from context**

```zena
// spawn, parallel.map, Region.new implicitly require sendable closures
// Compiler checks at call site

parallel.map(items, (item) => {
  counter = counter + 1;  // Error: closure passed to parallel.map captures 
                          // mutable 'counter' which is not Sendable
  process(item)
});
```

**Option 3: Type annotation**

```zena
// Function type includes sendability
type Mapper<T, R> = sendable (T) => R;

const parallelMap = <T, R>(items: array<T>, fn: sendable (T) => R) => array<R>;
```

**Comparison**:

| Approach | Pros | Cons |
|----------|------|------|
| `sendable` keyword | Intent explicit, self-documenting | More syntax |
| Inferred at call site | No new syntax | Errors at use site, not definition |
| Type annotation | Composable, works with higher-order functions | Verbose |

**Recommendation**: Support both:
- Explicit `sendable` keyword for clarity when needed
- Infer sendability at call sites for convenience (like Swift's `@Sendable`)
- Sendable closures satisfy regular closure types (subtyping)

**Use cases**:

```zena
// Region construction - closure must not capture external mutable state
let region = Region.new<AST>(sendable (self) => {
  // Can only use 'self', frozen values, and primitives
  self.alloc(Node, 1, null)
});

// Parallel map - each invocation independent
let results = parallel.map(items, sendable (item) => {
  // Safe: no shared mutable state
  transform(item)
});

// Thread spawn - transferred closure
spawn sendable {
  // Closure body can only access sendable captures
  heavyComputation()
};
```

##### Summary of Sharing Modes

| Mode | Mutability | Sharing | Use Case |
|------|------------|---------|----------|
| `frozen<T>` | Immutable | Free sharing | Parse trees, config, constants |
| `isolated<T>` | Mutable | Transfer only | Work items, results |
| `borrow` | Mutable | Scoped exclusive | Parallel subtree processing |
| `share` | Read-only | Scoped shared | Parallel analysis |
| `Region<T>` | Mutable | Transfer whole region | Object graphs (ASTs, DOMs) |

##### What We Avoid

- **No global mutable state**: Forces explicit sharing decisions
- **No raw `Mutex<T>`**: Scoped borrowing handles most cases
- **No proxy/membrane overhead**: Compiler enforces safety statically
- **No serialization** (future): Same-module threads share memory directly
- **No runtime Sendable checks**: Sendable is verified at compile time via capture analysis

##### Open Questions

1. **Ergonomics**: Is `isolated<T>` too verbose for common cases?
2. **Inference**: Can we infer `frozen` for classes with only frozen fields?
3. **Escape analysis**: Can compiler auto-`isolate` local objects?
4. **Region growth**: `MutableRegion` + `seal()` vs `region.extend()`? How does adding objects interact with existing references?
5. **Nested parallelism**: How do borrows compose with parallel regions?
6. **Region + isolated**: Can an `isolated<T>` point into a region? Or must the whole region be isolated?
7. **Region context cost**: Runtime context check on every `new` - acceptable overhead? Can we optimize common paths (no region active)?
8. **Sendable class inference**: Infer Sendable automatically, or require explicit `sendable class` annotation? Inference is convenient but may surprise users when a class becomes non-Sendable due to a change.
9. **Sendable closure syntax**: Explicit `sendable` keyword vs inferred at call site vs both?
10. **Context parameters integration**: Should regions use the same context mechanism as tracing/logging? Shared infrastructure vs specialized implementation?

#### Polyfill: Same API on Workers/Components (Today)

Before WASM GC gets native threading, we can implement the **same API** on top of:
- **JS**: Web Workers / Node worker_threads
- **WASI**: Spawning component instances (via wasmtime API or future WASI threading)

**Key insight**: Since workers run the **same compiled code**, we get:
- Identical class layouts and vtable offsets
- Type-safe serialization without schema negotiation
- Automatic `Sendable` enforcement at compile time

##### Implementation Strategy

| Concept | True Shared Memory | Workers (Polyfill) |
|---------|--------------------|--------------------|
| `frozen<T>` | Share pointer | Serialize → send → deserialize (cached) |
| `isolated<T>` | Transfer pointer | Serialize → send → delete original |
| `borrow` scope | Lend pointer | Serialize → work → send back → apply |
| `share` scope | Multiple read pointers | Serialize once → broadcast to all workers |
| `Region` | Transfer base pointer | Serialize all region objects together |

##### Generated Binary Serialization

The compiler generates efficient serializers for each `Sendable` type:

```zena
// Compiler generates (not user-visible):
impl Sendable for ASTNode {
  fn serialize(self, buf: ByteBuffer) {
    buf.writeI32(self.kind as i32);
    buf.writeI32(self.children.len());
    for child in self.children {
      child.serialize(buf);  // Recursive
    }
    self.span.serialize(buf);
  }
  
  fn deserialize(buf: ByteBuffer) => ASTNode {
    let kind = buf.readI32() as NodeKind;
    let childCount = buf.readI32();
    let children = #[];
    for i in 0..childCount {
      children.push(ASTNode.deserialize(buf));
    }
    let span = Span.deserialize(buf);
    ASTNode { kind, children, span }
  }
}
```

**Optimizations**:
1. **Varint encoding**: Small numbers use fewer bytes
2. **String interning**: Send intern ID instead of bytes (for shared string tables)
3. **Deduplication**: Track object identity to avoid serializing same object twice
4. **Batch transfers**: Serialize entire `Region` in one message
5. **Zero-copy views**: For primitives arrays, can share underlying buffer

##### Example: Parallel Parse (Same Code, Both Implementations)

```zena
// User code - identical for workers or true threading
const parseFiles = (files: array<string>) => array<isolated<AST>> {
  parallel.map(files, (file) => {
    let content = readFile(file);
    isolated(parse(content))  // Result wrapped as isolated
  })
};
```

**With workers (today)**:
```
Main                          Worker 1              Worker 2
────                          ────────              ────────
files[0..N/2] ──serialize──►  deserialize
                              parse()
                              serialize result
              ◄──────────────  
files[N/2..N] ──serialize────────────────────────►  deserialize
                                                    parse()
                                                    serialize result
              ◄────────────────────────────────────  
deserialize results
return isolated<AST>[]
```

**With true threading (future)**:
```
Main                          Thread 1              Thread 2
────                          ────────              ────────
files[0..N/2] ──pointer────►  
                              parse() 
                              ◄──return isolated──
files[N/2..N] ──pointer──────────────────────────►
                                                    parse()
              ◄────────────────return isolated─────  
return isolated<AST>[]
```

##### Worker Communication Layer

```zena
// Internal runtime (not user-visible)
class WorkerPool {
  #workers: array<Worker>;
  #pending: Map<i32, TaskState>;
  
  map<T: Sendable, R: Sendable>(items: array<T>, fn: (T) => R) => array<R> {
    let results = #[null; items.len()];
    let pending = items.len();
    
    for (i, item) in items.enumerate() {
      let worker = this.#workers[i % this.#workers.len()];
      let msg = WorkerMessage {
        taskId: i,
        fnId: fn.id,  // Function ID (same code = same ID)
        payload: item.serialize(),
      };
      worker.postMessage(msg);
    }
    
    while pending > 0 {
      let response = await this.#receiveAny();
      results[response.taskId] = R.deserialize(response.payload);
      pending = pending - 1;
    }
    
    results
  }
}
```

##### Performance Considerations

| Operation | Workers (Copy) | True Threading |
|-----------|---------------|----------------|
| Small object transfer | ~1μs | ~10ns |
| Large tree (10K nodes) | ~1ms | ~10ns |
| Read-only sharing | Copy per reader | Zero-cost |
| Borrow + return | 2× serialize | Zero-cost |

**When workers are still worth it**:
- Coarse-grained parallelism (parse whole files, not expressions)
- Long-running tasks where transfer << compute
- True CPU parallelism (vs cooperative async)

**When to wait for true threading**:
- Fine-grained parallelism (parallel tree visitors)
- Frequent small transfers
- Shared read-only data accessed by many tasks

##### Migration Path

```zena
// Code written today works tomorrow with zero changes
let results = parallel.map(files, parseFile);

// Today: WorkerPool with serialization
// Future: True threads with pointer sharing
// API is identical, semantics are identical
```

The `Sendable` trait, `frozen`, `isolated`, and scoped borrowing all have the same **semantics** whether backed by copying or true sharing. The compiler can switch implementations based on target capabilities.

---

## Recommended Approach for Zena

### Primary Model: Async/Await (Stackless CPS)

```zena
// Async functions compiled via CPS transform
const fetchUser = async (id: i32) => User;

// Structured task groups for concurrent work
const loadDashboard = async (userId: i32) => Dashboard {
  // All three run concurrently, all must complete
  let (user, posts, notifications) = async with TaskGroup.new() {
    yield (
      spawn fetchUser(userId),
      spawn fetchPosts(userId), 
      spawn fetchNotifications(userId),
    );
  };
  Dashboard { user, posts, notifications }
};
```

### Secondary Model: Parallel Workers (for CPU-bound work)

```zena
// For self-hosted compiler parallelism
const compileModules = (modules: array<Module>) => array<CompiledModule> {
  WorkerPool.parallel().map(modules, compileModule)
};
```

### Optional: Channels for Advanced Use Cases

```zena
// Pipeline processing with explicit await
const processPipeline = async () => {
  let input = Channel<RawData>.new();
  let parsed = Channel<ParsedData>.new();
  let output = Channel<Result>.new();
  
  async with TaskGroup.new() {
    spawn reader(input);           // reads from source, sends to input
    spawn parser(input, parsed);   // await input.recv(), await parsed.send()
    spawn processor(parsed, output);
    spawn writer(output);          // await output.recv(), writes to sink
  };
};

// Example stage function
const parser = async (input: Channel<RawData>, output: Channel<ParsedData>) => {
  while let raw = await input.recv() {  // Explicit await
    let parsed = parse(raw);
    await output.send(parsed);          // Explicit await
  }
};
```

---

## Implementation Phases

### Phase 1: CPS Transform Infrastructure
- [ ] Identify await points in async functions
- [ ] Compute live variables at each await point
- [ ] Generate state struct type per async function
- [ ] Transform function body to state machine

### Phase 2: Async/Await Syntax
- [ ] Add `async` keyword to function types
- [ ] Add `await` expression (parser, checker)
- [ ] Implement `Future<T>` type
- [ ] Codegen: state machine entry + callback functions

### Phase 3: WASI P3 Backend
- [ ] Emit callback ABI (entry returns status, companion callback)
- [ ] Waitable-set creation and management
- [ ] `task.return` for results
- [ ] Subtask tracking for spawned work

### Phase 4: JSPI Backend
- [ ] Detect "simple" async (sequential awaits on imports only)
- [ ] Emit linear code for simple cases (JSPI `suspending` handles suspension)
- [ ] CPS + JS event loop for concurrent cases
- [ ] JS runtime library: task registry, `Promise.race` loop, callback dispatch
- [ ] Generate JS glue for `suspending`/`promising` wrappers

### Phase 5: Structured Concurrency
- [ ] TaskGroup/Nursery primitive
- [ ] `spawn` within task groups
- [ ] Automatic cancellation on error
- [ ] Task state management (for CPS scheduler on all hosts)

### Phase 6: True Parallelism API (Worker Polyfill)
- [ ] `Sendable` trait (auto-derived for safe types)
- [ ] `frozen<T>` types (deeply immutable)
- [ ] `isolated<T>` references (unique ownership, transferable)
- [ ] Compiler-generated binary serialization for `Sendable` types
- [ ] `parallel.map()`, `parallel.scope()` with `borrow`/`share`
- [ ] WorkerPool implementation (JS Workers / WASI component spawning)
- [ ] String interning across workers (shared ID table)
- [ ] Region serialization (batch transfer of object graphs)

### Phase 7: Channels (Stdlib Library)
- [ ] `Channel<T>` class with `async send()` / `async recv()`
- [ ] Buffered vs unbuffered variants
- [ ] `trySend()` / `tryRecv()` non-blocking variants
- [ ] `Channel.select()` for waiting on multiple channels
- [ ] No special compiler support - just uses async/await

### Phase 8: Native Shared-Memory (When WASM GC + shared-everything-threads ships)
- [ ] Detect runtime supports shared GC refs
- [ ] Replace serialization with pointer sharing for `frozen<T>`
- [ ] Replace transfer-by-copy with move semantics for `isolated<T>`
- [ ] Implement true scoped borrowing (no serialize round-trip)
- [ ] Same API, zero code changes required

---

## Comparison Summary

| Model | Parallelism | Complexity | Safety | Best For |
|-------|-------------|------------|--------|----------|
| **async/await (CPS)** | Cooperative | Low | High | **Primary model** |
| Structured Concurrency | Cooperative | Medium | Very High | Scoped concurrency |
| Channels (stdlib) | Cooperative | Low | High | Pipelines, producer/consumer |
| **True Parallelism (polyfill)** | True | Medium | Very High | **Today: compilers, batch processing** |
| True Parallelism (native) | True | Medium | Very High | Future: same API, zero-copy |

**Design Principles**:
1. All suspension points are marked with `await` (no implicit blocking)
2. Channels are a stdlib library, not a language feature
3. True parallelism uses ownership types (`frozen`, `isolated`, `borrow`) not locks
4. Same API whether backed by worker serialization (today) or true sharing (future)

### Target Host Compatibility

| Feature | WASI P3 | JSPI (Browser/Node) |
|---------|---------|---------------------|
| Sequential async/await | ✅ Callback ABI | ✅ Linear `suspending` (simple) |
| Concurrent async/await | ✅ Callback ABI | ✅ CPS + JS event loop |
| spawn/TaskGroup | ✅ waitable-set | ✅ CPS + JS event loop |
| True Parallelism (polyfill) | ✅ Component instances + serialization | ✅ Web Workers + serialization |
| True Parallelism (native) | 🔮 shared-everything-threads | 🔮 SharedArrayBuffer + WASM threads |
| Streams | ✅ Native | ⚠️ Via ReadableStream |

🔮 = Future (requires WASM GC + shared-everything-threads proposal)

**Migration**: Code using `frozen`, `isolated`, `parallel.map()` works identically on polyfill (today) and native (future). Only the implementation changes - serialization becomes pointer sharing.

## References

### WASM & Web
- [WASI P3 Concurrency](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Concurrency.md)
- [JSPI (JavaScript Promise Integration)](https://github.com/WebAssembly/js-promise-integration/)
- [V8 JSPI Documentation](https://v8.dev/blog/jspi)
- [WASM Shared-Everything Threads Proposal](https://github.com/WebAssembly/shared-everything-threads)

### Concurrency Models
- [Structured Concurrency (Wikipedia)](https://en.wikipedia.org/wiki/Structured_concurrency)
- [Notes on Structured Concurrency](https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/)
- [What Color is Your Function?](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/)

### Reference Capabilities & Ownership
- [Pony Reference Capabilities](https://www.ponylang.io/learn/#reference-capabilities)
- [Pony Deny Capabilities Paper](https://www.ponylang.io/media/papers/fast-cheap-with-proof.pdf)
- [Verona Language (Microsoft Research)](https://github.com/microsoft/verona)
- [Swift Sendable and Actors](https://docs.swift.org/swift-book/LanguageGuide/Concurrency.html)
- [Rust Send and Sync](https://doc.rust-lang.org/nomicon/send-and-sync.html)
