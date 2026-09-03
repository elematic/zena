---
title: 'Resources and Ownership'
description: 'Deterministic resource management, affine types, ownership, and second-class borrowing in Zena.'
status: In progress
statusType: warning
---

::: warning In Progress Feature

Resource management and ownership is currently in active development. The core
foundation is implemented in `zena:ownership`. Static move checking,
compile-time affine drop, and second-class borrow checking are in progress or
planned, as indicated by the status badges throughout this page.

:::

Zena is a garbage-collected language, but not everything a program holds is
memory the collector can reclaim. Operating system file descriptors, WebAssembly
Component Model resource handles, linear-memory allocations, and foreign FFI
pointers require deterministic release actions. Because WebAssembly GC provides
no object finalizers, Zena provides an **affine type and ownership system** to
guarantee that external resources are released exactly once, on time, and never
used after release.

## Managed resources vs ordinary objects

In Zena, most values are ordinary **first-class** garbage-collected data:
primitives, strings, classes, arrays, records, and closures. You can pass them
anywhere, store them in fields or array elements, return them from functions,
and copy them freely. The WebAssembly garbage collector tracks their references
and reclaims memory automatically when they are no longer reachable.

However, programs frequently work with **external, non-GC resources**:

| Resource                       | Origin             | Release action       |
| :----------------------------- | :----------------- | :------------------- |
| **File descriptors & sockets** | WASI Preview 2     | Descriptor drop      |
| **Component Model handles**    | WIT `own<T>`       | `resource.drop`      |
| **Linear memory buffers**      | `Allocator.alloc`  | `Allocator.free`     |
| **Foreign references**         | Host / FFI imports | Imported deallocator |

These resources live outside the GC heap. Because WebAssembly GC has no
finalizers to attach cleanup to, failing to release an external resource leaks
it permanently.

To manage external resources safely, Zena distinguishes between three kinds of
references based on their ownership, aliasing, and where they can be stored:

- **Ordinary references (First-class)**: Can be stored anywhere in memory (class
  fields, record properties, arrays, globals), captured by any closure, and
  freely **aliased** (where multiple variables or fields hold references to the
  same object, like `let b = a;`).
- **Owning references (`Own<R>`)**: Carry the obligation to release the
  underlying resource. They enforce **single ownership**: you cannot create
  multiple owning aliases. Passing an owned resource to a **consuming
  parameter** (typed `Own<R>`) or assigning it to another variable **moves**
  ownership, consuming the source variable so it can no longer be read.
- **Borrowed references (`Borrow<R>`)**: Provide temporary access to a resource
  without ownership. They are **stack-bound** (or **second-class**): they exist
  only on the call stack for the duration of a function call. They can be aliased
  locally (e.g. passed down into multiple helper functions), but **cannot be
  stored in non-managed slots**—such as ordinary class fields, record fields,
  arrays, or escaping closures.

```zena
function logDescriptor(file: Borrow<FileDescriptor>) { /* ... */ }
function sendOverNetwork(file: Own<FileDescriptor>) { /* ... */ }

function process(file: Own<FileDescriptor>) {
  // ✅ OK: Pass to a borrowing parameter (file remains valid in caller)
  logDescriptor(file);

  // ✅ OK: Pass to a consuming parameter (moves ownership; 'file' is consumed)
  sendOverNetwork(file);

  // ❌ Compile error: Use of moved value 'file'
  // logDescriptor(file);
}

function inspect(f: Borrow<FileDescriptor>) {
  // ✅ OK: Pass borrow down to another helper function on the stack
  logDescriptor(f);

  // ❌ Compile error: Cannot store a stack-bound borrow in a heap field
  // myObject.file = f;

  // ❌ Compile error: Cannot put a stack-bound borrow into an array
  // myArray.push(f);
}
```

While managed resources cannot be stored in arbitrary heap slots or freely
aliased, these rules fit standard resource lifecycles: acquire an owned handle,
loan it to helper functions via borrows, and let the `Disposable` protocol
release it deterministically when the owner leaves scope.

## The Disposable protocol <span class="badge success">Implemented</span>

The foundation of resource cleanup is the `Disposable` interface from
`zena:ownership`:

```zena
interface Disposable {
  static symbol dispose;
  [dispose](): void;
}
```

```zena
import { Disposable } from 'zena:ownership';
```

The `[dispose]` method is **symbol-keyed** (`[Disposable.dispose]()`) to prevent
accidental name collisions with ordinary user-defined methods.

### Implementation obligations

Classes implementing `Disposable` must satisfy two rules:

1. **Idempotent**: Calling `[dispose]()` multiple times on an already-disposed
   instance must be a safe no-op and never release the underlying resource
   twice.
2. **Must not throw**: Release methods execute during exception and cancellation
   unwinding. Throwing an error inside `[dispose]()` would displace the active
   exception being propagated.

## Deterministic cleanup with using <span class="badge success">Implemented</span>

The `using` declaration provides scope-bound, deterministic cleanup for any
value implementing `Disposable`:

```zena
import { Disposable } from 'zena:ownership';

class MutexGuard implements Disposable {
  #mutex: Mutex;
  new(this.#mutex);

  [Disposable.dispose](): void {
    this.#mutex.unlock();
  }
}

function updateSharedState(mutex: Mutex): void {
  using guard = new MutexGuard(mutex);
  // ... perform protected operations ...
} // guard.[Disposable.dispose]() runs automatically here
```

### Execution guarantees

- **All exit paths**: `using` bindings are disposed on every path leaving the
  enclosing block—including normal completion, early `return`, `break`,
  `continue`, thrown exceptions, and async cancellation.
- **Reverse declaration order**: Multiple `using` declarations in the same block
  are released in reverse order of their declaration.
- **Nullable support**: If a `using` binding holds a nullable type
  (`Disposable?`), the release call is safely skipped when the value is `null`
  at scope exit:
  ```zena
  using f = maybeOpenFile(path); // f: File?
  if (f != null) {
    readFile(f);
  }
  // Released if non-null; skipped if null
  ```

## Resource classes and affine types <span class="badge warning">In progress</span>

While ordinary `Disposable` classes rely on explicit `using` declarations,
**resource classes** provide compiler-enforced affine ownership guarantees:

```zena
resource class FileDescriptor {
  #handle: i32;
  new(this.#handle);

  [Disposable.dispose](this: Own<this>): void {
    wasi_descriptor_drop(this.#handle);
  }
}
```

Declaring a `resource class` establishes three core invariants:

1. **Consuming release action**: The class must declare a release method with a
   consuming receiver (`this: Own<this>`).
2. **No bare unwrapped type**: Bare `FileDescriptor` is not a spellable type in
   Zena. Every reference must appear wrapped in a handle: `Own<FileDescriptor>`,
   `Borrow<FileDescriptor>`, or `Unmanaged<FileDescriptor>`.
3. **Inheritance hierarchy**: All superclasses of a resource class must also be
   resource classes, rooted at `Resource` from `zena:ownership`.

### Owner fields <span class="badge success">Implemented</span>

A resource class may hold owned resources in its fields — the container
inherits the release obligation, which is why only resource classes may
declare them:

```zena
resource class Connection {
  socket: Own<Socket>;
  log: Own<FileDescriptor> | null;
  new(this.socket, this.log);
}
```

- **Reads borrow**: `conn.socket` yields `Borrow<Socket>`, never a second
  owner. A nullable owner field reads as a nullable borrow.
- **Release is automatic**: After the dispose body runs, the compiler
  releases every owner field in reverse declaration order, so disposal is
  transitive through whole ownership trees without forwarding code. A class
  whose only release action is its fields (like `Connection` above) writes
  no dispose at all — the compiler synthesizes one.
- **Consuming methods move out**: Inside a method declaring
  `this: Own<this>` — `[Disposable.dispose]` above all — `this.socket`
  keeps its owner type, so a field can be handed to a consuming parameter,
  moved into a local, or returned to the caller. A moved-out field is
  skipped by the automatic release and consumed for the rest of the method;
  moving on only some paths is an error. Moving fields into locals is also
  how a dispose controls release order: the locals' scope-exit releases
  replace the automatic ones.
- Owner fields are immutable (`var` owner fields are rejected), and records
  and tuples cannot hold owners: structural values copy when they adapt,
  and a copy would duplicate the obligation.

### Affine type semantics

An **affine type** is a type whose values can be used _at most once_. Values of
type `Own<R>` follow strict move semantics:

- **Single owner**: Passing an `Own<R>` to a consuming function parameter,
  returning it, or storing it moves ownership to the recipient. The original
  variable binding is consumed and cannot be read again.
- **No multiple owners**: An owned resource cannot be aliased by multiple owning
  variables.
- **Automatic drop**: <span class="badge success">Implemented</span> If an
  `Own<R>` value reaches the end of its enclosing scope without being moved, the
  compiler automatically generates a call to its `[dispose]()` release action.

```zena
function process(file: Own<FileDescriptor>): void {
  sendOverNetwork(file); // Ownership moved to sendOverNetwork
  // read(file);         // Compile error: Use of moved value 'file'
}
```

## Handles: Own, Borrow, and Unmanaged <span class="badge success">Implemented</span>

Every reference to a resource exists behind one of three handle kinds defined in
`zena:ownership`:

| Handle             | Ownership & Aliasing                          | Permitted Storage Slots                         | Release Behavior                            |
| :----------------- | :-------------------------------------------- | :---------------------------------------------- | :------------------------------------------ |
| **`Own<R>`**       | **Single owner** (Moves on assignment)        | Local variables, returns, resource-class fields | Implicitly dropped at scope exit if unmoved |
| **`Borrow<R>`**    | **Borrow** (Multiple local aliases permitted) | **Stack slots only** (parameters & locals)      | Never releases (borrower)                   |
| **`Unmanaged<R>`** | **Unmanaged** (Freely aliasable)              | Any slot (heap fields, records, arrays)         | Never implicitly dropped                    |

### Zero runtime cost

All three handles are defined as zero-cost `distinct type` aliases over the
resource:

```zena
export distinct type Own<T> = T;
export distinct type Borrow<T> = T;
export distinct type Unmanaged<T> = T;
```

Handles carry static permissions for the compiler and are erased during code
generation. They introduce zero allocation overhead and no wrapper indirection.

### The four-universe lattice

Zena organizes types across two independent axes: **ownership semantics**
(governing single vs multiple aliases) and **storage extent** (governing whether
a value can escape the stack into heap slots):

| Universe         | Members                                                | Ownership & Aliasing       | Storage Extent        | Cleanup                     |
| :--------------- | :----------------------------------------------------- | :------------------------- | :-------------------- | :-------------------------- |
| **Unrestricted** | Primitives, `String`, ordinary classes, `Unmanaged<R>` | Multiple aliases permitted | Heap or stack         | Garbage collected           |
| **Affine**       | `Own<R>`                                               | **Single owner (Moves)**   | Heap or stack         | Implicit drop at scope exit |
| **Second-class** | `Borrow<R>`                                            | Multiple local aliases     | **Stack slots only**  | None (borrower)             |
| **Scoped**       | `Scoped<T>` (borrow-derived futures/iterators)         | **Single owner (Moves)**   | **Stack extent only** | Frame dropped at scope exit |

## Second-class borrows without lifetimes <span class="badge info">Planned</span>

In Zena, a borrowed handle `Borrow<R>` gives temporary access to a resource
without transferring ownership. Zena restricts borrows to **stack-bound
(second-class) values**:

1. **Stack-bound extents**: A `Borrow<R>` exists only on the call stack within
   its active loan scope. It cannot be stored in heap-allocated object fields or
   arrays, or captured by escaping closures.
2. **Implicit call-site borrowing**: Passing an `Own<R>` to a function expecting
   `Borrow<R>` automatically borrows the value without special operator syntax:
   ```zena
   let file: Own<FileDescriptor> = openFile('data.txt');
   readFile(file); // Implicitly passed as Borrow<FileDescriptor>
   // 'file' remains valid and owned here
   ```
3. **Local checking**: Because borrows cannot escape to the heap, the compiler
   checks borrowing rules entirely locally within each function, requiring no
   interprocedural analysis across function or module boundaries.

### Derived borrows and projections

Ordinary GC-managed fields on a resource (such as an `i32` size or a GC `String`
name) can be read and returned as ordinary first-class values that the garbage
collector manages.

However, when accessing an **inner resource handle** inside a borrowed parent
(such as an inner socket or an element in a collection of resources), returning
it produces a **derived borrow** whose extent is bounded to the parent's loan:

```zena
resource class Connection {
  socket: Own<Socket>;
  // ...
}

// Function with 1 borrow parameter: the returned Borrow<Socket>
// is automatically derived from the caller's borrowed connection.
function getSocket(c: Borrow<Connection>): Borrow<Socket> {
  return c.socket; // Field projection preserves the parent's borrow extent
}
```

The derivation rule is straightforward:

- **One borrow parameter**: A returned borrow derives from that parameter. The
  caller treats the returned borrow as bounded to the original resource it
  passed.
- **Zero borrow parameters**: Returning a borrow is illegal (there is no loan to
  derive from).
- **Two or more borrow parameters**: Returning a borrow is ambiguous and
  rejected unless explicitly specified.

### Borrows across suspension points

Because generator and async frames outlive individual function calls:

- **Generators** cannot accept `Borrow<R>` parameters, as their execution is
  lazy and runs after the caller's stack frame has yielded.
- **Async functions** can use `Borrow<R>` parameters during their initial
  synchronous execution, but borrows cannot remain live across an `await`
  suspension point.

### Scoped&lt;T&gt; for async and generators <span class="badge info">Planned</span>

To allow asynchronous operations to safely hold borrowed resources, Zena defines
the `Scoped<T>` wrapper:

```zena
async function readAsync(f: Borrow<FileDescriptor>): Scoped<Future<String>> {
  let data = await hostRead(f);
  return data;
}
```

`Scoped<Future<T>>` guarantees that the resulting future cannot escape the
caller's borrow scope, ensuring that the operation completes or cancels before
the borrowed resource can be released.

## Regime transitions: disown and adopt <span class="badge success">Implemented</span>

When a resource needs to be stored in a long-lived data structure or shared
across multiple systems, it can leave the affine regime using `disown()` and
return using `adopt()`:

```zena
import { disown, adopt, Own, Unmanaged } from 'zena:ownership';

// Transition from Affine to Unmanaged:
let ownedFile: Own<FileDescriptor> = openFile('log.txt');
let unmanagedFile: Unmanaged<FileDescriptor> = disown(ownedFile);

// Store in an ordinary collection:
let fileList = new Array<Unmanaged<FileDescriptor>>();
fileList.push(unmanagedFile);

// Re-enter the Affine regime:
let reclaimed: Own<FileDescriptor> = adopt(fileList.pop());
```

### Safety and state flags

`Resource` objects maintain a private lifecycle state flag (`Owned`, `Disowned`,
`Moved`, `Dropped`).

Transitions are guarded at runtime:

- `disown()` requires the resource to be in the `Owned` state and marks it
  `Disowned`. Calling `disown()` on an already-disowned resource throws a
  `ResourceStateError`.
- `adopt()` requires the resource to be `Disowned` and restores it to `Owned`.
  Attempting to adopt a resource currently owned by another context throws a
  `ResourceStateError`.
- Every consuming `[dispose]()` — explicit or compiler-generated — marks the
  resource `Dropped`, so adopting an already-released resource throws a
  `ResourceStateError` naming that state rather than a double free occurring.

### Non-forgeable handles

Outside of `zena:ownership`, explicit type casts into or out of `Own<T>`,
`Borrow<T>`, or `Unmanaged<T>` (e.g., `borrowVal as Own<T>`) are rejected by the
type checker. `disown()` and `adopt()` are the only valid mechanisms for
changing ownership regimes.

## Next

- [Async Programming](/guide/async/) — async functions, futures, and
  cancellation
- [Classes and Objects](/guide/classes/) — class declarations and interfaces
- [Errors](/guide/errors/) — exception handling and resource safety
