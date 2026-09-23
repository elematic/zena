---
title: 'Ownership and Resources'
description: 'Ownership and resource management in Zena: resource classes, handles, second-class borrows, scoped values, the Disposable protocol, and using bindings.'
---

::: warning Active Development

Zena's ownership and resource management system is under active development and
changing rapidly. While the core mechanisms (`Disposable`, `using`, `Own<T>`,
`Borrow<T>`, `Scoped<T>`, and `disown`/`adopt`) are implemented in the compiler
and standard library, borrow provenance analysis, exclusive leases, and static
move checking are actively evolving.

:::

Zena is a garbage-collected language targeting WebAssembly GC. Most values in a
program—strings, classes, arrays, records, and closures—are managed
automatically by the engine and reclaimed when no longer reachable.

However, programs frequently interact with **external host resources** that live
outside the WebAssembly managed heap:

- WebAssembly Component Model (`WIT`) and WASI resource handles (`own<T>` for
  files, sockets, streams, and async futures).
- Linear-memory buffers allocated via `Allocator.alloc`.
- Foreign pointers and handles provided by peer languages across FFI boundaries.

### The finalizer problem

**WebAssembly GC provides no object finalizers or destructors**. There is no
mechanism to attach cleanup code to garbage collection. If a program drops the
last reference to an open file or network socket without explicitly closing it,
that resource leaks permanently in the host operating system.

### Core concepts: Disposable, using, and ownership

To ensure deterministic cleanup without leaks, Zena provides three foundational
mechanisms that work together:

1. **`Disposable`**: An interface for any object that knows how to release its
   underlying resource via a `[Disposable.dispose]()` method.
2. **`using`**: A statement that binds a `Disposable` to a lexical block and
   guarantees that `dispose()` runs when the block exits—whether normally, via
   early `return`, or from an unhandled exception:
   ```zena
   {
    using file = openFile('log.txt');
    file.write('hello');
    // 'file' is automatically disposed when this block exits
   }
   ```
3. **`resource` classes & ownership**: When a resource cannot be confined to a
   single lexical block—such as returning an open file from a factory function
   or storing it in a persistent object—the **ownership system** statically
   tracks the resource across variable assignments and function boundaries:
   - **Resource classes**: Disposables that can only be referenced through an
     ownership system type like `Own<T>` or `Borrow<T>`.
   - **Single owner (`Own<R>`)**: An owned resource has exactly one owner at any
     time. Passing or assigning it _moves_ ownership and consumes the old
     variable.
   - **Compiler-guaranteed release**: If an owned resource reaches the end of
     its scope without being moved, the compiler automatically inserts its
     disposal.
   - **Second-class borrows (`Borrow<R>`)**: The owner can lend temporary access
     to functions on the call stack without surrendering ownership.

## Resource classes

A resource is declared using the `resource` class modifier:

```zena
resource class FileDescriptor {
  #handle: i32;
  new(this.#handle);

  [Disposable.dispose](this: Own<this>): void {
    wasi_descriptor_drop(this.#handle);
  }
}
```

A `resource class` automatically implements `Disposable`, but is subject to
strict static ownership rules enforced by the compiler:

1. **Mandatory consuming release action**: The class must provide a release
   method with a consuming receiver (`this: Own<this>`). The consuming receiver
   guarantees that once `dispose()` runs, the instance is consumed and cannot be
   accessed again.
2. **No bare unwrapped type**: Bare `FileDescriptor` cannot be written as a type
   annotation. Every reference must appear wrapped in a handle:
   `Own<FileDescriptor>`, `Borrow<FileDescriptor>`, or
   `Unmanaged<FileDescriptor>`.
3. **Move semantics**: Passing or assigning an owned resource moves ownership to
   the target. The source variable is consumed; attempting to read from it again
   is a compile error.
4. **Compiler-inserted cleanup (implicit drop)**: If an owned resource reaches
   the end of its scope without being moved or transferred, the compiler
   automatically inserts its disposal. Unlike `using`, release cannot be
   forgotten.
5. **Inheritance hierarchy**: All superclasses of a resource class must also be
   resource classes, rooted at `Resource` from `zena:core`.

### Owner fields

A resource class can hold owned resources in its fields:

```zena
resource class Connection {
  socket: Own<Socket>;
  log: Own<FileDescriptor>?;
  new(this.socket, this.log);
}
```

Owner fields follow strict ownership rules:

- **Field reads borrow**: Accessing an owner field (`conn.socket`) yields a
  borrow (`Borrow<Socket>`), never an owned duplicate. A nullable owner field
  reads as a nullable borrow (`Borrow<Socket>?`).
- **Automatic transitive release**: After the class's `[dispose]()` body runs,
  the compiler automatically disposes of every owned field in reverse
  declaration order. If a class only holds owned fields and requires no custom
  cleanup, the `[dispose]()` method can be omitted entirely and is synthesized
  by the compiler.
- **Stores release replaced values**: Assigning to a mutable (`var`) owner field
  moves the new resource in and automatically releases the displaced resource,
  ensuring the field holds exactly one live owner at all times.
- **Consuming methods move fields**: Inside a method declared with `this:
Own<this>`, accessing an owner field preserves its `Own` type, allowing the
  field to be moved into a local variable or returned to the caller.

## Handles: Own, Borrow, and Unmanaged

Every reference to a resource exists behind one of three handle kinds defined in
`zena:core`:

```zena
export distinct type Own<T> = T;
export distinct type Borrow<T> = T;
export distinct type Unmanaged<T> = T;
```

The three handle kinds are exhaustive for resources: a resource class has no
unwrapped form, so a reference to a resource is always typed with one of
`Own<R>`, `Borrow<R>`, or `Unmanaged<R>`.

Because handles are defined as `distinct type` aliases over the underlying
class, they are erased at compile time. At runtime, an `Own<R>` or `Borrow<R>`
is a plain WebAssembly GC reference with zero wrapper overhead or indirection.

### Comparison of handle kinds

| Handle             | Ownership & Aliasing                          | Permitted Storage Slots                    | Release Behavior                            |
| :----------------- | :-------------------------------------------- | :----------------------------------------- | :------------------------------------------ |
| **`Own<R>`**       | **Single owner** (Moves on assignment)        | Local variables, returns, resource fields  | Implicitly dropped at scope exit if unmoved |
| **`Borrow<R>`**    | **Borrow** (Multiple local aliases permitted) | **Stack slots only** (parameters & locals) | Never releases (borrower)                   |
| **`Unmanaged<R>`** | **Unmanaged** (Freely aliasable)              | Any slot (heap fields, arrays, closures)   | Never implicitly dropped                    |

### The four-universe lattice

Zena categorizes all types along two independent axes:

- **Ownership / Affineness** (vertical): whether a value permits multiple
  aliases (duplicable) or has a single owner that transfers via move semantics
  (affine).
- **Storage extent** (horizontal): whether a value is first-class (can be stored
  in heap fields, collections, and closures) or second-class (strictly bound to
  the active stack extent).

Together, these two axes define four distinct type universes:

1. **Unrestricted universe**: First-class and duplicable (ordinary GC objects,
   primitives, and `Unmanaged<R>`).
2. **Affine universe**: First-class with a single owner (`Own<R>`). It moves on
   assignment and is automatically dropped at scope exit if unmoved.
3. **Second-class universe**: Stack-bound and duplicable (`Borrow<R>`). It
   provides temporary, shared access to a resource without releasing it.
4. **Scoped universe**: Stack-bound and affine (`Scoped<T>`). When an
   asynchronous function or generator borrows a resource, the resulting
   computation—such as an in-flight `Future` or `Iterator`—holds a live
   execution frame tied to that borrow. Because it derives from a borrow, it
   cannot outlive the loan's stack extent (second-class); and because it owns an
   allocated execution frame, it cannot be duplicated and must be consumed
   (affine).

Arranged as a 2×2 grid, these axes visually form the four corners of the
lattice:

|                                        | First-class<br>_(Heap & stack)_                                                                          | Second-class<br>_(Stack extent only)_                                        |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| **Duplicable**<br>_(Multiple aliases)_ | **Unrestricted universe**<br>`Unmanaged<R>`, primitives, GC objects<br>_Reclaimed by garbage collection_ | **Second-class universe**<br>`Borrow<R>`<br>_Temporary loan; never releases_ |
| **Affine**<br>_(Single owner / Moves)_ | **Affine universe**<br>`Own<R>`<br>_Dropped at scope exit if unmoved_                                    | **Scoped universe**<br>`Scoped<T>`<br>_Must be consumed; frame drop_         |

::: note `Scoped<T>` is not a handle

Notice that while `Own<R>`, `Borrow<R>`, and `Unmanaged<R>` are handles that
apply specifically to `@resource` classes, **`Scoped<T>` is not a resource
handle**. It is a general-purpose type wrapper from `zena:core` that applies to
computations like `Future<T>` or `Iterator<T>` to place them into the fourth
corner of the lattice.

:::

## Second-class borrows

A borrowed handle `Borrow<R>` grants temporary access to a resource without
transferring ownership:

```zena
function inspect(file: Borrow<FileDescriptor>): void {
  println(file.size());
}

function run(): void {
  let file: Own<FileDescriptor> = openFile('log.txt');
  inspect(file); // Implicitly borrowed: 'file' remains owned in run()
}
```

Passing an `Own<R>` where a `Borrow<R>` is expected automatically borrows the
resource without special operator syntax.

### Stack extent boundaries

Borrows are **second-class values**:

- They exist strictly within the stack frame of the active loan.
- They cannot be stored in ordinary class fields, records, or arrays.
- They cannot be captured by escaping closures.

Because borrows cannot escape to the heap, the compiler verifies loan validity
locally within each function using natural stack scope boundaries.

### Provenance roots and derivation

Every borrowed value has a set of **provenance roots**—the owner variables whose
scope bounds the borrow's lifetime.

- **Field projections**: Accessing an inner resource field on a borrowed parent
  (`conn.socket`) produces a derived borrow rooted in the parent connection.
- **Invalidation on move**: Moving an owner variable invalidates all borrows
  rooted in that variable. Reading a borrow after its root has been moved
  produces a compile error.
- **Return derivation**: A function with a single borrow parameter can return a
  derived borrow; the caller treats the returned borrow as bounded to the
  argument it passed.

### Borrows across suspension points

Because asynchronous functions and generators can pause execution and outlive
their calling stack frames:

- **Async functions**: A `Borrow<R>` parameter may be read before the first
  `await` point (which executes synchronously in the caller's frame). Borrows
  cannot remain live across an `await` unless wrapped in `Scoped<T>`.
- **Generators**: Generators cannot take bare `Borrow<R>` parameters because
  generator execution is deferred until the caller drives the iterator.

### Exclusive borrows: Leases

In addition to shared borrows (`Borrow<R>`), Zena supports **exclusive borrows**
(leases). A lease grants exclusive temporary access to a resource.

Leases allow mutating `var` owner fields or performing stateful operations
without requiring the caller to permanently surrender ownership or perform a
verbose move-and-return sequence.

### Comparison with lifetime systems

Languages like Rust enforce resource and borrow safety through universal
ownership and non-lexical lifetimes (NLL) parameterized by lifetime variables
(`'a`). In Rust, references are first-class types that can be stored in structs
and collections, requiring lifetime parameters to be declared and propagated
across types, traits, and function signatures.

Zena achieves borrow safety with a simpler model:

- **Borrows never escape to the heap**: Because `Borrow<R>` cannot be stored in
  class fields, records, or arrays, loans are strictly bounded by the call stack
  and their provenance roots.
- **No lifetime variables**: Zena functions and classes never declare `'a`
  parameters or lifetime bounds.
- **Local verification**: The compiler checks borrowing validity within each
  function's lexical extents and provenance roots rather than solving
  whole-program lifetime constraints across complex data structures.

## Scoped values and the scoped modifier

Unlike resource handles (`Own<R>`, `Borrow<R>`, `Unmanaged<R>`), which wrap
`@resource` classes to manage their disposal, **`Scoped<T>` is not a resource
handle**. It is a general-purpose type wrapper from `zena:core` that can apply
to _any_ type `T`—including ordinary garbage-collected classes such as `Future`
or `Iterator`.

`Scoped<T>` marks a second-class value that may not be duplicated and may not
outlive the extent it derives from. It allows asynchronous operations and
generators to safely work with borrowed resources without violating loan
lifetimes.

### Why second-class types cannot bind bare type parameters

An unconstrained generic type parameter `<T>` assumes `T` represents an
ordinary, first-class value that can be freely copied, stored in heap slots, or
captured:

```zena
// Ordinary generic function
let store = <T>(x: T) => {
  let list = new Array<T>();
  list.push(x); // Permitted for first-class T
};
```

Passing a second-class type like `Borrow<File>` or `Scoped<Future<i32>>` to
`store` would place the stack-bound value in a heap array, violating its extent.
Therefore, ordinary `<T>` type parameters reject second-class type arguments at
compile time.

### The `<scoped T>` syntax

To permit generic code to accept second-class arguments, prefix the type
parameter with the contextual `scoped` modifier:

```zena
let keep = <scoped T>(x: T): T => {
  return x;
};
```

The `scoped` keyword is contextual: it acts as a modifier only when followed by
an identifier in a type-parameter list. It composes directly with bounds:

```zena
import { Disposable } from 'zena:core';

let processResource = <scoped T extends Disposable>(res: T): void => {
  // ...
};
```

### Discipline inside `scoped T` bodies

The body of a `scoped T` generic is checked under strict second-class
discipline:

1. **Affine consumption**: A `scoped T` argument must be consumed exactly once
   on every execution path—either by returning it (under derivation rules),
   passing it to another `scoped` parameter, or awaiting it (for scoped
   futures). Leaving a `scoped T` unconsumed produces an abandonment compile
   error.
2. **No heap storage**: A `scoped T` value may not be stored in object fields,
   arrays, or records:
   ```zena
   let invalidStore = <scoped T>(x: T): i32 => {
     let list = new Array<T>();
     // Compile error: scoped type parameter 'T' may not be stored in containers
     list.push(x);
     return 0;
   };
   ```
3. **No closure capture**: A `scoped T` value may not be captured by closures:
   ```zena
   let invalidCapture = <scoped T>(x: T): i32 => {
     // Compile error: scoped type parameter 'T' may not be captured by closures
     let fn = () => x;
     return 0;
   };
   ```

### Standard combinators

The `<scoped T>` modifier relaxes the call-site requirement so second-class
values can be processed with standard collection and concurrency combinators:

```zena
import { Future } from 'zena:async';

Future.allSettled<scoped T>(futures: Array<T>): Future<Array<Outcome<T>>>;
```

Combinators that operate over scoped values use `<scoped T>` to accept them
safely. For example, `Future.allSettled` accepts an array of scoped futures,
suspending until all have settled, and guarantees that every future is awaited
before the loan's stack extent can end.

Similarly, `zena:core` exports `map`, `filter`, and `take` for scoped iterators
(`Scoped<Iterator<T>>`), allowing generator pipelines to transform borrowed
streams without allocation or lifetime errors.

## The Disposable protocol

The foundation of resource cleanup in Zena is the `Disposable` interface from
`zena:core`:

```zena
import { Disposable } from 'zena:core';

export interface Disposable {
  static symbol dispose;
  [Disposable.dispose](): void;
}
```

The release method is symbol-keyed (`[Disposable.dispose]()`) to prevent name
collisions with user-defined methods.

### Implementation obligations

Classes implementing `Disposable` must satisfy two requirements:

1. **Idempotence**: Calling `dispose()` multiple times on an already-disposed
   instance must be safe and must not release the underlying resource twice.
2. **Non-throwing during unwinds**: Release methods execute during exception and
   cancellation unwinding. Throwing inside `dispose()` would displace the active
   exception being propagated.

## Deterministic cleanup with using

The `using` statement binds a disposable resource to the current lexical block
and guarantees that its cleanup runs when the block exits:

```zena
import { Disposable } from 'zena:core';

class MutexGuard implements Disposable {
  #mutex: Mutex;
  new(this.#mutex);

  [Disposable.dispose](): void {
    this.#mutex.unlock();
  }
}

function updateState(mutex: Mutex): void {
  using guard = new MutexGuard(mutex);
  // Protected operations...
} // guard.[Disposable.dispose]() runs automatically here
```

### Execution guarantees

- **All exit paths**: Bound resources are disposed on every path leaving the
  block, including normal completion, early `return`, `break`, `continue`,
  thrown exceptions, and async cancellation.
- **Reverse declaration order**: Multiple `using` declarations in the same block
  are released in reverse order of their declaration (LIFO).
- **Nullable support**: If a `using` binding holds a nullable type
  (`Disposable?`), disposal is safely skipped if the value is `null` at scope
  exit.
- **Expression form**: For resources where no local binding name is needed, the
  unbound expression form is supported: `using acquire(lock);`.

### Scope-bound cleanup vs. ownership

While `using` is simple and predictable for temporary, scope-bound objects (like
mutex guards or tracing spans), explicit cleanup has distinct trade-offs
compared to the ownership system:

- **Lexically locked cleanup**: `using` always disposes at block exit. It cannot
  be used to return a live resource from a factory function or store it in an
  object field that outlives the function. Attempting to return or store a
  `using` binding escapes the object in an already-disposed state.
- **Voluntary discipline**: Writing `using` is opt-in. If a developer
  accidentally writes `let file = openFile(path)` instead of `using`, the
  compiler cannot intervene, and in WebAssembly GC the resource leaks
  permanently.
- **Use-after-dispose**: An ordinary `Disposable` can be aliased while active
  and accessed after the `using` block has closed it.

For critical external resources that move across functions or require leak-free
guarantees, use [Resource classes](#resource-classes) and the ownership system
instead.

## Regime transitions: disown and adopt

When an owned resource must be handed to a system that cannot statically verify
single ownership—such as an FFI boundary, an event loop callback table, or a
shared cache—Zena allows explicit transitions between `Own<R>` and
`Unmanaged<R>`:

```zena
import { disown, adopt } from 'zena:ownership';

let file: Own<FileDescriptor> = openFile('log.txt');

// Transition to unmanaged: static ownership ceases, caller is responsible
let raw: Unmanaged<FileDescriptor> = disown(file);

// file cannot be read here (moved by disown)

// Reclaim single ownership:
let reclaimed: Own<FileDescriptor> = adopt(raw);
```

### Safety rules

- **`disown(own)`**: Consumes the `Own<R>` binding via move semantics and marks
  the runtime resource header as _disowned_. It returns an `Unmanaged<R>` handle
  that can be freely aliased, stored on the heap, or passed across FFI.
- **`adopt(unmanaged)`**: Re-asserts unique ownership. It checks the runtime
  header to ensure the resource has not already been adopted, closed, or freed.
  If valid, it returns a new `Own<R>` handle and sets the header back to
  _owned_.
- **Handles are not forgeable**: You cannot cast between `Own<R>`, `Borrow<R>`,
  and `Unmanaged<R>` using the `as` operator. Transitions must go through
  `disown()` and `adopt()`.
