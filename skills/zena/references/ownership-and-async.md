# Ownership, Resources, and Async Cancellation in Zena

## Deterministic Cleanup in a Garbage-Collected Language

Ordinary Zena values (classes, strings, arrays, records, tuples, closures) live on the WebAssembly GC heap and need no manual memory management. WebAssembly GC provides **no object finalizers or destructors**, so external host handles (WASI file descriptors, sockets, streams, linear-memory allocations, FFI pointers) leak permanently unless explicitly released. Zena provides two mechanisms: lexical `using` blocks and affine `resource class` handles.

## `Disposable` and `using`

`Disposable` (`zena:core`) uses a symbol-keyed release method so it never collides with domain method names:

```zena
import {Disposable} from 'zena:core';

class TempDir implements Disposable {
  path: String;
  var #closed = false;
  new(this.path);

  [Disposable.dispose](): void {
    if (!this.#closed) {
      this.#closed = true;
      removeDir(this.path);
    }
  }
}

function buildArchive(): void {
  using scratch = new TempDir('/tmp/work');
  writeOutput(scratch.path);
} // scratch.[Disposable.dispose]() runs on return, break, throw, or cancel
```

Rules for `Disposable` and `using`:

- `[Disposable.dispose]()` must be **idempotent** and **must not throw** (it executes during exception and cancellation unwinding).
- Multiple `using` statements in one block dispose in reverse declaration order (LIFO). Nullable `Disposable?` bindings skip disposal when `null`, and `using acquireLock();` works without a variable name.
- `using` always disposes when the block exits; never return or store a `using`-bound value.

## `resource class` and Erased Handles (`Own`, `Borrow`, `Unmanaged`)

When a resource must be returned from factories, moved across functions, or stored inside another resource, declare a `resource class`:

```zena
import {Borrow, Disposable, Own} from 'zena:core';

resource class Socket {
  #fd: i32;
  new(this.#fd);

  send(data: ByteArray): void {
    hostSend(this.#fd, data);
  }

  [Disposable.dispose](this: Own<this>): void {
    hostClose(this.#fd);
  }
}

function writeHeader(sock: Borrow<Socket>, header: ByteArray): void {
  sock.send(header);
}

function serve(): void {
  let sock: Own<Socket> = acceptSocket();
  writeHeader(sock, headerBytes()); // `Own<Socket>` implicitly borrows as `Borrow<Socket>`
} // `sock` was not moved; compiler inserts `[Disposable.dispose]()` here
```

### Handle rules

`Own<R>`, `Borrow<R>`, and `Unmanaged<R>` (`zena:core`) are compile-time-erased `opaque type` handles—at runtime they are plain Wasm GC references with zero wrapper allocation. Bare `Socket` is never valid as a type annotation:

| Handle         | Semantics                                       | Allowed Slots                                       | Cleanup                                         |
| :------------- | :---------------------------------------------- | :-------------------------------------------------- | :---------------------------------------------- |
| `Own<R>`       | Single owner; moves on assignment or `Own` pass | Locals, returns, `resource class` fields            | Compiler-inserted drop at scope exit if unmoved |
| `Borrow<R>`    | Shared temporary loan (duplicable)              | **Second-class** (parameters and stack locals only) | Never drops                                     |
| `Unmanaged<R>` | Manual escape hatch (`disown` / `adopt`)        | Any slot (ordinary class fields, arrays, closures)  | Manual (`adopt` back to `Own<R>` to drop)       |

- **No lifetime annotations**: Because `Borrow<R>` cannot be stored in heap fields, arrays, records, or closures, loans cannot outlive their owner's stack frame, and Zena functions never need `'a` lifetime parameters.
- **Owner fields**: A `resource class` holding `socket: Own<Socket>` yields `Borrow<Socket>` on field reads (`conn.socket`), automatically drops displaced values on `var` field writes, and transitively drops all owned fields in reverse order after `[Disposable.dispose]()` runs (if no custom cleanup is needed, `[Disposable.dispose]()` is synthesized).
- **Regime transitions**: `disown(own)` (`zena:core`) consumes `Own<R>` and returns `Unmanaged<R>`; `adopt(raw)` checks the runtime lifecycle flag (throwing `ResourceStateError` if already adopted or dropped) and restores `Own<R>`. Handles cannot be converted with `as`.

## Suspension Points and `Scoped<T>` (`<scoped T>`)

Async functions and generators (`gen function`, `async gen function`) suspend execution frames:

- A `Borrow<R>` held across an `await` (or inside a generator driving a borrowed source) produces a **`Scoped<Future<T>>`** or **`Scoped<Iterator<T>>`** (`zena:core`).
- `Scoped<T>` is both **second-class** (cannot be stored in containers or captured by closures) and **affine** (must be consumed once on every path via `await` or `for-in`).
- Ordinary generic parameters `<T>` reject second-class types (`Borrow<R>`, `Scoped<F>`). Prefix type parameters with `scoped` (`function run<scoped T>(x: T)`) when writing generic helpers over borrowed or scoped values; `zena:core` and `zena:async` provide `Future.allSettled<scoped T>` and `map`/`filter`/`take` over `Scoped<Iterator<T>>`.

## Async Functions, Generators, and Structured Concurrency

- **Signatures**: Top-level `async function` can infer `Future<T>`, whereas **`async` methods must annotate `: Future<T>`** and **`gen` methods must annotate `: Iterator<T>`**.
- **Unified iteration**: Every synchronous `Iterator<T>` extends `AsyncIterator<T>` via the 3-slot unboxed `Step<T>` / `AsyncStep<T>` protocol, so `for await (let x in src)` drives both synchronous and asynchronous sources.
- **`TaskGroup` and `CancelScope` (`zena:async`)**:
  ```zena
  import {TaskGroup, checkCancellation} from 'zena:async';

  async function loadPage(): Future<Page> {
    let group = new TaskGroup(); // child of ambient `currentScope()`
    let user = group.spawn(async () => fetchUser());
    let feed = group.spawn(async () => fetchFeed());
    await group.join(); // cancels siblings if any task throws
    return new Page(await user, await feed);
  }
  ```
  Use `TaskGroup.detached()` for background work that must outlive its caller's cancel scope, `checkCancellation()` inside CPU-bound loops, and `currentScope().isCancelled` for non-unwinding inspection.

## First-Class Cancellation Channel

Cancellation unwinds on a dedicated channel distinct from both `return` and `Error`:

1. **`catch (e)` never catches cancellation**: Error recovery blocks cannot accidentally swallow a cancellation directive from an ancestor `TaskGroup`.
2. **Checkpoints**: Cancellation is delivered only when entering `await`, resuming from `await`, or calling `checkCancellation()`. Synchronous stretches between checkpoints run uninterrupted.
3. **`cancel` and `shielded` blocks**:
   - Add `cancel { ... }` on an async `try` (before any `catch` or `finally`) to observe cancellation side effects before unwinding continues (`return`/`break`/`continue` cannot exit a `cancel` block).
   - Wrap asynchronous cleanup awaits inside **`shielded { ... }`** so checkpoints inside `finally` run to completion even though the ambient scope is already cancelled:
   ```zena
   async function streamData(url: String): Future<String> {
     let conn = await connect(url);
     try {
       return await conn.readAll();
     } cancel {
       metrics.record('stream-cancelled');
     } finally {
       shielded {
         await conn.flush();
         await conn.close();
       }
     }
   }
   ```
