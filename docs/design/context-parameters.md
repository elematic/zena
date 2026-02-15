# Context Parameters

## Overview

Context parameters are function parameters that can be automatically provided from
the enclosing lexical scope. They are **purely syntactic sugar** for explicit parameter
passing—no runtime mechanism, no hidden state, no cost beyond what you'd pay for
manual parameter threading.

## Motivation

Many cross-cutting concerns require threading values through call chains:

- Tracing/observability
- Logging
- Database connections
- Authentication/authorization context
- Configuration
- Cancellation tokens

Without language support, you either:

1. Pass these explicitly through every call (tedious, noisy)
2. Use global/thread-local state (unsafe with async, hidden dependencies)
3. Use dependency injection frameworks (complex, runtime cost)

Context parameters provide option (1) with the ergonomics of option (2) and none of
the downsides of option (3).

## Syntax

### Declaring Context Parameters

A `context` parameter is declared with the `context` keyword before the parameter name:

```zena
let log = (message: string, context logger: Logger?) => {
  logger?.write(message);
};

let processData = (data: Data, context tracer: Tracer?, context logger: Logger?) => {
  logger?.write("Processing...");
  tracer?.mark("process:start");
  // ...
};
```

**Rules:**

- Context parameters must have a default value (typically `null` or a sentinel)
- Context parameters must come after regular parameters
- Multiple context parameters are allowed

### Providing Context

The `with` block introduces a named context value into scope:

```zena
with tracer: Tracer.console() {
  processData(myData);  // tracer automatically provided
}
```

Multiple contexts:

```zena
with tracer: Tracer.console(), logger: Logger.file("app.log") {
  processData(myData);  // both tracer and logger provided
}
```

The bound name is available for direct use in the block:

```zena
with tracer: Tracer.console() {
  tracer.mark("custom");  // Use directly
  processData(myData);    // Also passed implicitly
}
```

### Explicit Override

Context can always be passed explicitly, overriding any scope-provided value:

```zena
with tracer: Tracer.console() {
  // Explicitly pass a different tracer
  processData(myData, tracer: Tracer.null());

  // Explicitly pass null to disable
  processData(myData, tracer: null);
}
```

### Alternative Syntax Options

```zena
// Option A: context keyword (proposed)
let fn = (x: i32, context tracer: Tracer?) => { ... };
with tracer: Tracer.console() { fn(42); }

// Option B: using keyword (Scala-inspired)
let fn = (x: i32, using tracer: Tracer?) => { ... };
given tracer: Tracer.console() { fn(42); }

// Option C: implicit keyword
let fn = (x: i32, implicit tracer: Tracer?) => { ... };
with tracer: Tracer.console() { fn(42); }
```

**Recommendation**: `context` is clear and self-documenting. `with name: value`
mirrors named parameter syntax and is familiar from Python/JS resource management.

## Code Generation

### Core Principle: Just Parameter Passing

Context parameters compile to regular parameters. The `context` keyword only affects
how the compiler resolves arguments at call sites.

### Example: Basic Call

```zena
let greet = (name: string, context logger: Logger?) => {
  logger?.write("Hello, " + name);
};

// Call without context
greet("Alice");

// Call with context
with logger: Logger.console() {
  greet("Bob");
}
```

**Compiles to:**

```wasm
;; greet function - logger is just a regular parameter
(func $greet (param $name (ref $String)) (param $logger (ref null $Logger))
  ;; ... null check and call logger.write if present
)

;; Call without context - pass null directly
(call $greet (local.get $name) (ref.null $Logger))

;; Call with context - pass the context value
(local.set $__ctx_logger (call $Logger_console))
(call $greet (local.get $name) (local.get $__ctx_logger))
```

**Key observation**: Both are direct calls. No indirection, no lookup, no runtime cost
difference.

### Example: Nested Calls

```zena
let outer = (context tracer: Tracer?) => {
  inner();  // tracer flows through
};

let inner = (context tracer: Tracer?) => {
  tracer?.mark("inner");
};

with tracer: Tracer.console() {
  outer();
}
```

**Compiles to:**

```zena
// Desugared - context is explicitly threaded by name
let outer = (tracer: Tracer?) => {
  inner(tracer: tracer);  // Compiler adds this (name matches)
};

let inner = (tracer: Tracer?) => {
  tracer?.mark("inner");
};

let __ctx_tracer = Tracer.console();
outer(tracer: __ctx_tracer);
```

The compiler transforms:

1. Calls inside `with` blocks → add context arguments by matching names
2. Calls to context-accepting functions inside other context-accepting functions →
   forward context parameters with matching names

### Example: Function Values

When a function with context parameters is used as a value, the context parameters
are part of its type:

```zena
let greet = (name: string, context logger: Logger?) => { ... };

// Type of greet is: (string, context logger: Logger?) -> void
let fn: (string, Logger?) -> void = greet;

// When called via the variable, context is NOT auto-provided
fn("Alice", null);           // Must pass explicitly
fn("Alice", myLogger);       // Or pass a logger

// But when called by name, context lookup applies
with logger: Logger.console() {
  greet("Alice");            // Context provided (name 'logger' matches)
  fn("Alice");               // ERROR: fn requires 2 arguments
}
```

**Rationale**: Once a function is stored in a variable, the compiler can't know at
the call site which context parameter names it expects. This keeps the semantics
simple and predictable.

### Example: Higher-Order Functions

```zena
let withTiming = <T>(name: string, fn: () -> T, context tracer: Tracer?) => {
  tracer?.mark(name + ":start");
  let result = fn();
  tracer?.mark(name + ":end");
  return result;
};

with tracer: Tracer.console() {
  withTiming("compute", () => {
    expensiveOperation();  // tracer NOT available here (closure doesn't declare it)
  });
}
```

If the closure needs context, it must declare it:

```zena
with tracer: Tracer.console() {
  withTiming("compute", (context tracer: Tracer?) => {
    tracer?.mark("inside");  // Now available
  });
}
```

## Runtime Cost Analysis

### Zero Additional Cost

| Scenario                                         | Cost                      |
| ------------------------------------------------ | ------------------------- |
| Function with context param, no context in scope | Direct call, null passed  |
| Function with context param, context in scope    | Direct call, value passed |
| Function without context param                   | Unchanged                 |
| Context value unused (`logger?.write` with null) | Null check only           |

**No indirect calls.** Context resolution is purely compile-time.

### Comparison to Alternatives

| Approach             | Call overhead      | Memory          | Async-safe |
| -------------------- | ------------------ | --------------- | ---------- |
| Context parameters   | None (direct call) | None            | ✅         |
| Global variable      | None               | Global slot     | ❌         |
| Thread-local         | TLS lookup         | TLS slot        | ❌         |
| Dictionary passing   | Hash lookup        | Dict allocation | ✅         |
| Dependency injection | Virtual dispatch   | Container       | ✅         |

### When Context IS Used

The cost is exactly what you'd pay for explicit parameter passing:

- One additional parameter per context
- One local variable per `with` block
- Null checks for `context?.method()` calls

### Potential Optimization: Specialization

For hot paths, the compiler could specialize functions based on whether context is
null or non-null:

```zena
let process = (data: Data, context tracer: Tracer?) => {
  tracer?.mark("start");
  // ... lots of code ...
  tracer?.mark("end");
};
```

Could generate two versions:

- `$process_traced(data, tracer)` - full tracing
- `$process_untraced(data)` - tracer code eliminated

Call sites with known-null context call the untraced version. This is an optimization,
not required for correctness.

## Type System Integration

### Context Parameter Types

Context parameters are visible in the function type:

```zena
let fn = (x: i32, context t: Tracer?) => x * 2;
// Type: (i32, Tracer?) -> i32
```

### Subtyping

A function without a context parameter is a subtype of one with (if defaults match):

```zena
let simple: (i32) -> i32 = (x) => x * 2;
let withCtx: (i32, Tracer?) -> i32 = simple;  // OK - Tracer? defaults to null
```

Wait, this needs more thought. Let me reconsider...

Actually, it's simpler to say: context parameters are just optional parameters with
special call-site behavior. The type includes them, period.

```zena
let fn = (x: i32, context t: Tracer?) => x * 2;
// Type: (i32, Tracer?) -> i32
// Callable as fn(42) or fn(42, tracer) or fn(42, tracer: t)
```

## Interaction with Other Features

### Async Functions

Context is captured at closure creation, like any other variable:

```zena
with tracer: Tracer.console() {
  let fut = async {
    await fetchData();
    tracer.mark("fetched");  // tracer was captured (it's in lexical scope)
  };
}
```

For context parameters in async functions:

```zena
let fetchAndTrace = async (url: string, context tracer: Tracer?) => {
  tracer?.mark("fetch:start");
  let data = await fetch(url);
  tracer?.mark("fetch:end");
  return data;
};

with tracer: Tracer.console() {
  await fetchAndTrace("http://...");  // tracer passed at call time, captured into async state
}
```

The tracer is passed when the async function is _called_, and captured into the
async state machine. No special async context propagation needed.

### Generics

Context parameters work with generics:

```zena
let traced = <T>(name: string, fn: () -> T, context tracer: Tracer?) => {
  tracer?.mark(name + ":start");
  let result = fn();
  tracer?.mark(name + ":end");
  return result;
};
```

### Interfaces

Interfaces can declare methods with context parameters:

```zena
interface Processor {
  let process: (data: Data, context tracer: Tracer?) -> Result;
}
```

Implementations must include the context parameter:

```zena
class MyProcessor implements Processor {
  let process = (data: Data, context tracer: Tracer?) => {
    tracer?.mark("MyProcessor:process");
    // ...
  };
}
```

## Scope Lookup Rules

### Name-Based Lookup (Recommended)

Context is matched by **name**, like named parameters:

```zena
// Declare context parameter with a name
let process = (data: Data, context tracer: Tracer?) => { ... };

// Provide context by name
with tracer: Tracer.console() {
  process(myData);  // 'tracer' matched by name, type must be assignable
}
```

This is analogous to named function arguments:

- The name must match
- The type of the provided value must be assignable to the parameter type
- Multiple contexts of the same type are allowed (different names)

```zena
with requestTracer: Tracer.console(), backgroundTracer: Tracer.file("bg.log") {
  handleRequest(req);   // uses requestTracer
  runBackgroundJob();   // uses backgroundTracer
}
```

**Pros**: Explicit, predictable, supports multiple contexts of same type  
**Cons**: Name coupling between provider and consumer

### Relation to Dynamic Scoping

Context parameters are essentially **compile-time dynamic scoping**:

| Aspect          | Dynamic Scoping | Context Parameters       |
| --------------- | --------------- | ------------------------ |
| Resolution time | Runtime         | Compile time             |
| Follows         | Call stack      | Lexical scope            |
| Lookup          | By name         | By name                  |
| Cost            | Runtime lookup  | Zero (parameter passing) |

Traditional dynamic scoping (as in early Lisps, Emacs Lisp, Perl `local`) resolves
names at runtime by walking the call stack. This is powerful but:

- Unpredictable (depends on who called you)
- Hard to reason about
- Runtime cost for lookup

Context parameters give similar ergonomics but with:

- Compile-time resolution (predictable)
- Lexical scoping (follows code structure, not call structure)
- Zero runtime cost (compiles to parameter passing)

### Using Symbols for Context Names

To avoid name collisions across modules, context names can be **symbols** instead
of plain identifiers:

```zena
// In module zena:performance
export symbol tracer;

// Function uses the symbol as context name
let process = (data: Data, context :tracer: Tracer?) => {
  tracer?.mark("start");
  // ...
};

// Provide context using the symbol
import {tracer} from "zena:performance";

with :tracer: Tracer.console() {
  process(myData);
}
```

This leverages Zena's existing [Static Symbols](../language-reference.md#static-symbols)
feature. Benefits:

- **No collisions**: Two modules can both have a `tracer` context without conflict
- **Explicit imports**: You must import the symbol to provide that context
- **Compile-time checked**: Typos are caught (symbol must exist)

For convenience, simple identifiers work for local/internal contexts:

```zena
// Simple name - fine for local use
with logger: myLogger {
  doStuff();
}

// Symbol - for public APIs and cross-module contexts
with :zena:performance.tracer: myTracer {
  doStuff();
}
```

### Why Not Type-Based Lookup?

Scala-style type-based lookup (`given Tracer = ...`) is more concise but:

1. **Too implicit**: Hard to see which context is being used
2. **One per type**: Can't have two `Tracer` contexts in scope
3. **Spooky action**: A function's behavior changes based on types in scope
4. **Harder to trace**: "Where did this value come from?" requires understanding implicit resolution

Name-based lookup is more explicit—you can see exactly what's being provided and
consumed by looking at the names.

## Open Questions

1. **Nested `with` blocks**: Does inner shadow outer, or error on conflict?

```zena
with tracer: Tracer.console() {
  with tracer: Tracer.file("log.txt") {  // Shadow or error?
    process();
  }
}
```

Recommendation: Shadow (like variable bindings). Inner scope wins.

2. **Context in module scope**: Can a module provide default context?

```zena
module myapp {
  with tracer: Tracer.console();  // Module-level context?

  // All functions in module get tracer unless overridden
}
```

3. **Required context**: Can context be non-optional (must be provided)?

```zena
let process = (data: Data, context tracer: Tracer) => { ... };
// Error if called without a 'tracer' in scope
```

This would make missing context a compile error rather than passing null.

4. **Symbol syntax in `with`**: Best syntax for symbol-named contexts?

```zena
// Option A: Same as member access
with :tracer: Tracer.console() { ... }

// Option B: Explicit symbol reference
with tracer = :Performance.tracer: Tracer.console() { ... }

// Option C: Import binds the name
import {tracer} from "zena:performance";  // Now 'tracer' refers to the symbol
with tracer: Tracer.console() { ... }
```

5. **Multiple contexts with same name**: Error or shadowing?

```zena
with tracer: Tracer.console() {
  with tracer: Tracer.file("x.log") {  // Shadow? Error?
    ...
  }
}
```

## Summary

Context parameters are **compile-time dynamic scoping by name**:

- `context name: Type` declares a parameter resolved from lexical scope by name
- `with name: value { }` introduces a named context into scope
- Names can be identifiers (local use) or symbols (cross-module, collision-free)
- Compiles to direct calls with explicit arguments—just parameter passing
- Zero runtime overhead beyond normal parameter passing
- Async-safe (captured like any closure variable)
- Type-safe (provided value must be assignable to parameter type)

---

## Part 2: Runtime Context Stacks

Context parameters require explicit opt-in through the call chain. For some use cases—
particularly observability and tracing—you want context to flow through code you don't
control. This requires a **runtime** mechanism.

### The Use Case

```zena
// You control this
let myApp = () => {
  withTracer(Tracer.console()) {
    thirdPartyLibrary.process(data);  // You don't control this
  };
};

// Third-party code (you can't modify)
let process = (data: Data) => {
  helper(data);
};

let helper = (data: Data) => {
  // You want tracing here, but library doesn't know about your tracer
};
```

Context parameters can't help here—the library doesn't declare `context tracer: Tracer?`.
You need runtime context that flows implicitly through the call stack.

### Design: Context Stacks

```zena
module zena:context {
  // Create a context key (like a typed thread-local)
  let createContext: <T>(defaultValue: T) => Context<T>;

  interface Context<T> {
    // Get current value (from stack or default)
    let current: () => T;

    // Run a block with a new value pushed onto the stack
    let with: <R>(value: T, fn: () => R) => R;
  }
}
```

**Usage:**

```zena
import {createContext} from "zena:context";

// Define a context (module-level)
let TracerContext = createContext<Tracer?>(null);

// Provider
let myApp = () => {
  TracerContext.with(Tracer.console(), () => {
    thirdPartyLibrary.process(data);  // Unaware of tracing
  });
};

// Consumer (could be deep in the call stack)
let instrument = () => {
  let tracer = TracerContext.current();  // Finds the nearest provider
  tracer?.mark("here");
};
```

### Implementation: Synchronous Case

For synchronous code, this is simple—a global stack:

```zena
// Conceptual implementation
class Context<T> {
  let defaultValue: T;
  var stack: List<T> = [];

  let current = () => {
    if (stack.isEmpty()) defaultValue else stack.last()
  };

  let with = <R>(value: T, fn: () => R) => {
    stack.push(value);
    try {
      return fn();
    } finally {
      stack.pop();
    }
  };
}
```

The `try/finally` ensures the stack is popped even if `fn` throws.

### The Async Problem

When code is async, the call stack doesn't represent the logical "task":

```zena
TracerContext.with(Tracer.console(), async () => {
  await fetchData();       // Suspends, stack unwinds
  // ... other tasks might run here, modifying TracerContext ...
  processData();           // Is our tracer still current? Maybe not!
});
```

**Timeline:**

1. `with()` pushes tracer onto stack
2. `fetchData()` starts, hits `await`, suspends
3. Stack unwinds (we're back in the event loop)
4. **Other code runs**, maybe does its own `TracerContext.with()`
5. `fetchData()` completes, our async function resumes
6. `TracerContext.current()` returns... what?

### Solution 1: Task-Local Storage

Each async task/fiber gets its own context storage, inherited from its parent:

```
Task A: TracerContext → Tracer.console()
  └─ Task B (spawned from A): TracerContext → Tracer.console() (inherited)
  └─ Task C (spawned from A): TracerContext → Tracer.console() (inherited)

Task D: TracerContext → Tracer.file("x.log")
  └─ Task E (spawned from D): TracerContext → Tracer.file("x.log") (inherited)
```

**How it works:**

- Each task has its own context map
- When you spawn a task (via `async { }` or similar), it copies the parent's context
- `Context.with()` modifies only the current task's context
- `Context.current()` reads from the current task's context

**Pros:**

- Clean mental model (each task is isolated)
- Works well with structured concurrency
- No "restore" logic needed—context is per-task

**Cons:**

- Requires runtime support for "current task" tracking
- Memory overhead (each task stores context copy)
- Context changes after spawn don't propagate to children

**Languages using this:**

- Go: `context.Context` (explicit passing, but often stored in task-locals)
- Java: `ThreadLocal` (per-thread, not per-task—problematic with async)
- Rust/Tokio: `task_local!` macro

### Solution 2: AsyncContext (JS Proposal Style)

Track the "logical async context" through the entire async execution graph:

```
AsyncContext tracks: "which closure was created in which context?"

When closure created:
  closure.[[AsyncContext]] = currentContext

When closure invoked:
  savedContext = currentContext
  currentContext = closure.[[AsyncContext]]  // Restore creator's context
  try { closure() }
  finally { currentContext = savedContext }
```

**How it works:**

- Every closure captures the async context at creation time
- When the closure is called, the captured context is restored
- This happens automatically for all closures (promises, callbacks, etc.)

**Pros:**

- Context "flows" through async boundaries automatically
- No explicit propagation needed
- Works with any async pattern (promises, callbacks, event handlers)

**Cons:**

- Every closure has overhead (capture + restore)
- Runtime must intercept all closure creation and invocation
- Invasive—affects the entire runtime

### The Collection Problem (Your Concern)

You identified a key issue with AsyncContext-style approaches:

```zena
// A collection that stores callbacks
class EventEmitter {
  var listeners: List<() => void> = [];

  let on = (callback: () => void) => {
    listeners.push(callback);
  };

  let emit = () => {
    for (let cb in listeners) {
      cb();  // Which context? Creator's or current?
    }
  };
}

// Usage
TracerContext.with(Tracer.forRequestA(), () => {
  emitter.on(() => handleEvent());  // Created in request A's context
});

TracerContext.with(Tracer.forRequestB(), () => {
  emitter.emit();  // Called in request B's context
});
```

**The question:** When `handleEvent()` runs, should it see:

- Request A's tracer (the context when the callback was created)?
- Request B's tracer (the context when `emit()` was called)?

**AsyncContext's answer:** Automatically restore creator's context. The closure captures
context at creation, and `emit()` automatically restores it.

**The problem you identified:** If AsyncContext is NOT automatic, then `EventEmitter`
must explicitly decide:

```zena
// EventEmitter must manually capture and restore
class EventEmitter {
  var listeners: List<(callback: () => void, context: AsyncContext)> = [];

  let on = (callback: () => void) => {
    listeners.push((callback, AsyncContext.current()));  // Manual capture
  };

  let emit = () => {
    for (let (cb, ctx) in listeners) {
      ctx.run(() => cb());  // Manual restore
    }
  };
}
```

If `EventEmitter` forgets to do this, context is lost. Every collection, every
callback-storing API must remember.

### Solution 3: Automatic Closure Capture (Potential Zena Approach)

What if closure creation automatically captured runtime context, just like it
captures lexical variables?

```zena
// Conceptual: closures have an implicit [[Context]] slot
let callback = () => {
  TracerContext.current()  // Uses the [[Context]] captured at creation
};

// The closure captures the runtime context automatically
TracerContext.with(Tracer.forRequestA(), () => {
  emitter.on(() => handleEvent());  // [[Context]] = { TracerContext: Tracer.forRequestA() }
});

// Later, when callback is invoked, [[Context]] is restored
emitter.emit();  // Automatically restores creator's context for each callback
```

**How this differs from JS AsyncContext:**

| Aspect             | JS AsyncContext             | Auto Closure Capture       |
| ------------------ | --------------------------- | -------------------------- |
| Capture            | Runtime must intercept      | Part of closure creation   |
| Scope              | All async operations        | Just closures              |
| Mental model       | "Current context flows"     | "Closures capture context" |
| Collection problem | Still exists (needs manual) | Solved (automatic)         |

**The key insight:** If context capture is part of closure semantics (like lexical
variable capture), then collections automatically get the right behavior—they store
closures, and closures carry their context.

### Implementation Considerations for Zena

**Option A: Explicit Task-Local (Simplest)**

```zena
// Each async block gets its own context copy
let ctx = createContext<Tracer?>(null);

ctx.with(myTracer, async () => {
  // This async block has myTracer
  await something();
  ctx.current();  // Still myTracer (task-local)
});
```

- Simple to implement
- Predictable
- Doesn't help with callbacks stored in collections

**Option B: Auto Closure Capture (More Powerful)**

Every closure captures the current context state:

```zena
ctx.with(myTracer, () => {
  let callback = () => {
    ctx.current();  // Returns myTracer (captured at closure creation)
  };

  runLater(callback);  // Even if runLater() is in a different context
});
```

- Solves the collection problem
- Every closure is slightly larger (carries context snapshot)
- More intuitive ("closures remember their environment")

**Option C: Opt-In Capture**

Let callers decide when to capture:

```zena
ctx.with(myTracer, () => {
  // Regular closure - uses current context at call time
  let callback1 = () => ctx.current();

  // Capturing closure - captures context at creation
  let callback2 = ctx.capture(() => ctx.current());

  emitter.on(callback2);  // Explicit capture
});
```

- Maximum control
- Still requires awareness at each use site

### Recommendation for Zena

Consider a **layered approach**:

1. **Context Parameters** (compile-time, zero-cost)
   - For dependency injection, configuration, typed dependencies
   - Functions explicitly declare what they need
   - No runtime overhead

2. **Task-Local Context** (runtime, simple)
   - For observability that needs to cross async boundaries
   - Each async task inherits parent's context
   - `Context.current()` reads from current task

3. **Optional: Closure Context Capture** (runtime, automatic)
   - Closures automatically snapshot context at creation
   - Restored when closure is invoked
   - Solves the collection/callback problem
   - Higher implementation complexity

The third option is the most powerful but also the most invasive. It could be:

- Always on (like lexical capture)
- Opt-in per context (`let TracerContext = createContext({ captureInClosures: true })`)
- Opt-in per closure (`ctx.capturing(() => { ... })`)

### Code Example: Full Tracing Solution

```zena
import {createContext} from "zena:context";

// Create a context that auto-captures in closures
let TracerContext = createContext<Tracer?>(null, { captureInClosures: true });

// High-level API
let withTracing = <T>(tracer: Tracer, fn: () => T) => {
  return TracerContext.with(tracer, fn);
};

let currentTracer = () => TracerContext.current();

// Usage - works through unaware code and collections
withTracing(Tracer.console(), () => {
  // Direct call
  currentTracer()?.mark("start");

  // Through unaware library
  thirdPartyLib.process(data);  // If it calls currentTracer(), it works

  // Stored in collection
  eventEmitter.on(() => {
    currentTracer()?.mark("event");  // Still gets our tracer!
  });

  // Async
  await fetchData();
  currentTracer()?.mark("fetched");  // Still works (task-local)
});
```

### Comparison with Other Languages

| Language            | Mechanism              | Async          | Closures  | Automatic |
| ------------------- | ---------------------- | -------------- | --------- | --------- |
| Go                  | `context.Context`      | Manual passing | N/A       | No        |
| Java                | `ThreadLocal`          | ❌ Broken      | ❌ No     | N/A       |
| Kotlin              | `CoroutineContext`     | ✅ Yes         | ❌ No     | No        |
| JS (proposed)       | `AsyncContext`         | ✅ Yes         | ⚠️ Manual | Partial   |
| Rust/Tokio          | `task_local!`          | ✅ Yes         | ❌ No     | No        |
| **Zena (proposed)** | Context + auto-capture | ✅ Yes         | ✅ Yes    | Yes       |

### Open Questions for Runtime Context

1. **Semantics**: What about closures that escape their creating task?
   - Should they carry the snapshot forever?
   - Or re-link to the "current" context?

2. **WASM implementation**: How do we track "current task" in WASM?
   - Need cooperation with async runtime
   - Could use linear memory for context stacks

3. **Interaction with context parameters**: Should `context tracer: Tracer?` also
   check the runtime context if not provided lexically?

   ```zena
   let process = (context tracer: Tracer?) => { ... };

   TracerContext.with(myTracer, () => {
     process();  // Should this find myTracer from runtime context?
   });
   ```

### Implementation: Closure Context Capture Performance

#### Can Context Be a Single Reference?

Yes. The "context" captured by a closure can be a single pointer to a shared,
immutable context frame:

```
Closure object:
┌─────────────────────┐
│ function pointer    │
│ captured variables  │  ← existing closure fields
│ context reference ──────► Context Frame (shared, immutable)
└─────────────────────┘     ┌─────────────────────┐
                            │ TracerContext → T1  │
                            │ LoggerContext → L1  │
                            │ parent ─────────────────► Parent Frame
                            └─────────────────────┘
```

**Key insight**: Context frames are immutable. `Context.with()` creates a new frame
that points to the parent, forming a linked list. Multiple closures created in the
same `with` block share the same frame.

```zena
TracerContext.with(tracer1, () => {
  // Current frame: { TracerContext: tracer1, parent: null }

  let a = () => { ... };  // Captures reference to frame
  let b = () => { ... };  // Captures same reference (shared!)
  let c = () => { ... };  // Same frame, not copied

  LoggerContext.with(logger1, () => {
    // New frame: { LoggerContext: logger1, parent: outer frame }

    let d = () => { ... };  // Captures this inner frame
  });
});
```

**Cost**: One additional pointer per closure (same as capturing one variable).

#### Does It Slow Down Closure Creation?

**Minimal overhead:**

- Read current context frame pointer (one global/task-local read)
- Store it in the closure (one pointer write)

This is comparable to capturing a single lexical variable. If no context is active
(frame is null or default), it's just storing null.

```wasm
;; Closure creation with context capture (pseudocode)
(func $create_closure (param $func_ptr i32) (param $captures (ref $array)) (result (ref $closure))
  (struct.new $closure
    (local.get $func_ptr)
    (local.get $captures)
    (global.get $current_context_frame)  ;; One extra read + store
  )
)
```

#### Does It Slow Down Closure Execution?

**Only if context is actually used:**

```wasm
;; Closure invocation
(func $invoke_closure (param $closure (ref $closure))
  ;; Save current context
  (local.set $saved_ctx (global.get $current_context_frame))

  ;; Restore closure's captured context
  (global.set $current_context_frame (struct.get $closure $context))

  ;; Call the function
  (call_ref (struct.get $closure $func_ptr))

  ;; Restore previous context
  (global.set $current_context_frame (local.get $saved_ctx))
)
```

**Cost per invocation**: 2 global reads + 2 global writes (save/restore).

But this can be optimized...

#### Static Analysis: Eliding Unnecessary Context

The compiler can analyze whether context is actually used:

**1. Closures that don't use context:**

```zena
let add = (a: i32, b: i32) => a + b;  // No context usage

// Compiler sees: nothing in add() or its callees uses Context.current()
// → Don't capture context, don't restore on invocation
```

**2. Call graphs with no context usage:**

```zena
let processData = (data: Data) => {
  let helper = () => transform(data);  // No context here
  helper();
};
// Entire call tree has no context usage → no context overhead anywhere
```

**3. Only capture/restore when needed:**

```zena
let logAndProcess = () => {
  TracerContext.current()?.mark("start");  // Uses context!
  processData(data);                        // No context usage
};

// Compiler can:
// - Capture context in logAndProcess closure (it uses TracerContext)
// - Not capture in closures called only from processData path
```

#### Analysis Approach

The compiler performs reachability analysis:

```
1. Mark all functions that call Context.current() as "context-using"
2. Propagate: any function that calls a "context-using" function is also marked
3. Closures only capture context if they (or reachable callees) are marked
4. Closure invocation only saves/restores if the closure might use context
```

**Conservative fallback**: If analysis can't determine (e.g., calling through
function pointers, dynamic dispatch), assume context might be used.

#### Optimization Levels

| Level        | Behavior                                     | Overhead              |
| ------------ | -------------------------------------------- | --------------------- |
| None needed  | Closure doesn't use context                  | Zero                  |
| Capture only | Uses context but doesn't call other closures | 1 ptr per closure     |
| Full         | Uses context + calls unknown closures        | Save/restore per call |

#### Example: Tracing Pipeline

```zena
TracerContext.with(myTracer, () => {
  // This closure uses context
  let traced = <T>(name: string, fn: () => T) => {
    TracerContext.current()?.mark(name + ":start");  // ← context-using
    let result = fn();
    TracerContext.current()?.mark(name + ":end");    // ← context-using
    return result;
  };

  // This closure doesn't use context directly
  let compute = () => {
    return heavyMath(data);  // No context calls in heavyMath
  };

  traced("compute", compute);
});
```

**Compiler analysis:**

- `traced`: captures context (calls `TracerContext.current()`)
- `compute`: no context capture needed (nothing in call tree uses context)
- `heavyMath`: no context overhead (pure computation)

**Result:** Only `traced` pays the context cost. `compute` and `heavyMath` run at
full speed with no context overhead.

#### Summary: Performance Characteristics

| Operation           | Cost                             | When                                      |
| ------------------- | -------------------------------- | ----------------------------------------- |
| Closure creation    | +1 pointer                       | Only if closure (or callees) uses context |
| Closure invocation  | +4 global ops                    | Only if closure uses context              |
| `Context.current()` | 1 global read + linked list walk | Only when called                          |
| `Context.with()`    | Allocate frame + 1 global write  | Only when called                          |

**Key points:**

- Single reference per closure (not a copy)
- Frames are shared and immutable
- Static analysis elides overhead when context isn't used
- Cost is proportional to actual context usage, not closure count

## References & Prior Art

### Scala

Scala has the most mature implementation of this concept, with two distinct designs:

**Scala 2: Implicits**

- [Implicit Parameters](https://docs.scala-lang.org/tour/implicit-parameters.html) —
  Parameters marked `implicit` are resolved from scope
- Very powerful but criticized for being confusing (implicits did too many things:
  implicit conversions, implicit classes, implicit parameters)
- Could lead to surprising behavior due to implicit conversions

**Scala 3: Contextual Abstractions (Redesign)**

- [Given and Using Clauses](https://docs.scala-lang.org/scala3/book/ca-given-using-clauses.html) —
  Complete redesign separating concerns
- `given` defines a context value, `using` declares a context parameter
- [Contextual Abstractions Overview](https://docs.scala-lang.org/scala3/reference/contextual/) —
  Full reference
- [Relationship with Scala 2 Implicits](https://docs.scala-lang.org/scala3/reference/contextual/relationship-implicits.html) —
  Migration guide and design rationale

```scala
// Scala 3 syntax
def process(data: Data)(using tracer: Tracer): Result =
  tracer.mark("start")
  // ...

given Tracer = ConsoleTracer()
process(myData)  // tracer resolved from given
```

The Scala 3 redesign is worth studying—they explicitly separated:

- `given` — defining instances (like type class instances)
- `using` — requesting parameters from context
- Extension methods — adding methods to types (was implicit class)
- Implicit conversions — now explicit and discouraged

### Kotlin: Context Receivers

- [Context Receivers](https://kotlinlang.org/docs/context-receivers.html) (Experimental)
- [KEEP-259: Context Receivers](https://github.com/Kotlin/KEEP/blob/master/proposals/context-receivers.md) —
  Design proposal

```kotlin
context(Logger)
fun process(data: Data): Result {
    log("Processing...")  // Logger methods available
    // ...
}

with(ConsoleLogger()) {
    process(myData)  // Logger provided by with block
}
```

Kotlin's approach is slightly different—context receivers make the context's _members_
available, not just the value. More like extension receivers but from scope.

### Haskell: Type Classes & Implicit Configurations

Haskell's type classes are related but different:

- [Type Classes](https://www.haskell.org/tutorial/classes.html) — Compile-time resolved
- [reflection package](https://hackage.haskell.org/package/reflection) — Runtime implicit configuration
- [Implicit Parameters](https://ghc.gitlab.haskell.org/ghc/doc/users_guide/exts/implicit_parameters.html) —
  GHC extension, somewhat deprecated

```haskell
-- Type class constraint (resolved at compile time)
process :: Tracer t => Data -> t -> Result

-- Implicit parameter (dynamic scoping - less common)
process :: (?tracer :: Tracer) => Data -> Result
```

### OCaml: Modular Implicits (Proposed)

- [Modular Implicits Paper](https://arxiv.org/abs/1512.01895) (White, Bour, Yallop)
- Never merged into OCaml mainline, but influenced other designs
- Proposed resolving module values implicitly based on type

### Koka: Effect Handlers

- [Koka Language](https://koka-lang.github.io/koka/doc/book.html)
- Uses algebraic effect handlers, which subsume implicit parameters
- Effects are declared in function types and handled by enclosing handlers

```koka
effect tracer
  fun mark(name: string): ()

fun process(data: data): result
  mark("start")  // Uses tracer effect
  // ...

fun main()
  with handler
    fun mark(name) = println(name)
  process(myData)
```

Effect handlers are more powerful (they can also express async, exceptions, etc.)
but more complex than simple context parameters.

### Algebraic Effects (Research)

Several research languages explore algebraic effects, which generalize context:

- [Eff](https://www.eff-lang.org/)
- [Frank](https://arxiv.org/abs/1611.09259)
- [Links](https://links-lang.org/)

### What We Take From Each

| Language | Feature           | What we adopt           | What we avoid                            |
| -------- | ----------------- | ----------------------- | ---------------------------------------- |
| Scala 2  | Implicits         | Scope-based lookup      | Implicit conversions, complexity         |
| Scala 3  | given/using       | Clean separation        | Type class focus                         |
| Kotlin   | Context receivers | `with` block syntax     | Member import (too magic)                |
| Haskell  | Type classes      | Compile-time resolution | Complex type system                      |
| Koka     | Effects           | Inspiration for tracing | Full effect system (too complex for now) |

Our design aims for the **simplest useful subset**: scope-based parameter passing
with explicit opt-in, no implicit conversions, no type class machinery.
