# Automatic Resource Management Design

This document details the design for automatic resource management (ARM) in Zena, including the `Disposable` interface, disposal semantics, and the `DisposableGroup` utility.

## 1. Overview

Resource management is the practice of ensuring that system resources (file handles, network connections, locks, etc.) are properly released when no longer needed. Many languages provide mechanisms to automate this process, reducing bugs caused by forgotten cleanup.

### 1.1. Goals

1. **Safety**: Resources should be reliably disposed, even in the presence of exceptions or early returns.
2. **Simplicity**: The mechanism should be easy to understand and use correctly.
3. **Performance**: Minimal runtime overhead for resource tracking.
4. **Compatibility**: Work well with Zena's existing type system and WASM-GC architecture.

## 2. Approaches in Other Languages

### 2.1. JavaScript: Explicit Resource Management (Opt-In)

JavaScript's [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) proposal (Stage 3) uses the `using` keyword:

```javascript
{
  using file = openFile('data.txt');
  // file.read()...
} // file[Symbol.dispose]() called automatically

// Async variant
{
  await using connection = await openConnection();
} // connection[Symbol.asyncDispose]() awaited
```

**Key Characteristics:**
- **Opt-in**: Must use `using` declaration; regular `const` doesn't dispose.
- **Symbol-based protocol**: `Symbol.dispose` and `Symbol.asyncDispose` methods.
- **Block-scoped**: Disposal occurs at block exit.
- **DisposableStack**: Utility for managing multiple resources.

**Pros:** Explicit intent, backward compatible.
**Cons:** Easy to forget `using`, requires symbol infrastructure.

### 2.2. Python: Context Managers (Opt-In)

Python's `with` statement uses the context manager protocol:

```python
with open('data.txt') as file:
    data = file.read()
# file.__exit__() called automatically
```

**Key Characteristics:**
- **Opt-in**: Must use `with` statement.
- **Protocol-based**: `__enter__` and `__exit__` methods.
- **Can transform exceptions**: `__exit__` receives exception info.
- **contextlib**: Utilities like `ExitStack` for multiple resources.

**Pros:** Clear scope, exception info available.
**Cons:** Requires explicit `with`, can't be used in all contexts.

### 2.3. C#: IDisposable and `using` (Opt-In)

C# has the `IDisposable` interface and `using` statement:

```csharp
using (var file = new FileStream("data.txt", FileMode.Open))
{
    // ...
} // file.Dispose() called

// Modern syntax (C# 8+)
using var file = new FileStream("data.txt", FileMode.Open);
// Disposed at end of enclosing scope
```

**Key Characteristics:**
- **Opt-in**: `using` statement or declaration.
- **Interface-based**: `IDisposable.Dispose()`.
- **Finalizers available**: GC can call finalizers as backup.
- **IAsyncDisposable**: Async variant.

**Pros:** Clean syntax, widely adopted pattern.
**Cons:** Finalizers are non-deterministic and have overhead.

### 2.4. Java: try-with-resources (Opt-In)

Java 7+ has try-with-resources:

```java
try (FileInputStream fis = new FileInputStream("data.txt")) {
    // ...
} // fis.close() called
```

**Key Characteristics:**
- **Opt-in**: Must use `try` with resource declaration.
- **Interface-based**: `AutoCloseable.close()`.
- **Suppressed exceptions**: Primary exception preserved, others suppressed.

**Pros:** Built into exception handling.
**Cons:** Verbose syntax, limited to `try` blocks.

### 2.5. Rust: RAII with Drop Trait (Automatic)

Rust uses Resource Acquisition Is Initialization (RAII):

```rust
{
    let file = File::open("data.txt")?;
    // ...
} // file.drop() called automatically
```

**Key Characteristics:**
- **Automatic**: All types implementing `Drop` are cleaned up.
- **Deterministic**: Cleanup at end of scope, no GC involved.
- **Ownership-based**: Single owner determines cleanup timing.
- **ManuallyDrop**: Escape hatch for manual control.

**Pros:** No forgetting to clean up, zero overhead abstraction.
**Cons:** Requires ownership/borrowing system, complex for beginners.

### 2.6. Go: defer (Opt-In)

Go uses `defer` for cleanup:

```go
file, err := os.Open("data.txt")
if err != nil { return err }
defer file.Close()
// ...
```

**Key Characteristics:**
- **Opt-in**: Must explicitly `defer`.
- **Function-scoped**: Deferred calls run at function exit.
- **Stack-based**: LIFO execution order.

**Pros:** Simple, flexible.
**Cons:** Easy to forget, function-scoped not block-scoped.

### 2.7. Swift: Automatic Reference Counting (Automatic)

Swift uses ARC with `deinit`:

```swift
class FileHandle {
    deinit {
        close()
    }
}
// Cleaned up when reference count reaches zero
```

**Key Characteristics:**
- **Automatic**: Cleanup when no references remain.
- **Deterministic** (mostly): Reference counting is predictable.
- **Cycle detection**: Weak/unowned references to break cycles.

**Pros:** Usually deterministic, no explicit cleanup needed.
**Cons:** Cycles can leak, timing depends on reference patterns.

## 3. Analysis for Zena

### 3.1. Zena's Constraints

1. **WASM-GC Runtime**: Zena targets WASM-GC, which uses garbage collection. There are no destructors or finalizers—objects are collected at the GC's discretion.

2. **Sound Type System**: Zena's type system is sound. We can use types to enforce correct resource handling.

3. **Static Compilation**: The compiler has full program visibility, enabling optimizations and static checks.

4. **No Exceptions (Currently)**: Zena doesn't have exceptions yet. Resource cleanup must handle early returns.

5. **Block Scoping**: Variables are block-scoped, providing natural cleanup points.

### 3.2. Why Not Automatic (RAII-style)?

While Rust's automatic approach is appealing, it doesn't fit Zena well:

1. **No Ownership System**: Zena uses garbage collection, not ownership. Multiple references to the same resource are allowed.

2. **GC Non-Determinism**: WASM-GC doesn't guarantee when objects are collected. Finalizers aren't available.

3. **Reference Ambiguity**: With GC, the compiler can't know when the "last" reference goes away at compile time.

4. **Performance Cost**: Tracking resource lifetimes automatically would require reference counting or escape analysis, adding runtime overhead.

### 3.3. Why Opt-In is Better for Zena

1. **Explicit Intent**: The programmer clearly marks which resources need deterministic cleanup.

2. **Predictable Timing**: Cleanup happens at a well-defined point (block exit), not when GC runs.

3. **Simpler Implementation**: No need for reference counting or complex lifetime analysis.

4. **Matches Mental Model**: Developers familiar with JS/C#/Python will recognize the pattern.

5. **Type System Integration**: We can use the type system to encourage correct usage.

### 3.4. Reducing the Hazard of Forgetting

The main risk of opt-in systems is forgetting to use the cleanup mechanism. Zena can mitigate this through:

1. **Lint Warnings**: Warn when a `Disposable` is assigned to a non-`using` binding.

2. **IDE Integration**: Display hints/warnings for disposable types not using `using`.

3. **Type Markers**: A `MustDispose` marker interface that generates errors if not used with `using`.

4. **Naming Conventions**: Encourage names like `openFile()` that imply resource acquisition.

## 4. Proposed Design

### 4.1. The `Disposable` Interface

```typescript
interface Disposable {
  _dispose(): void;
}
```

**Design Decisions:**

1. **Protected Method (`_dispose`)**: The dispose method uses the protected prefix (`_`) rather than being public. This:
   - Signals that external code shouldn't typically call it directly.
   - Allows the class to call it internally or through `using`.
   - Hides it from IDE autocomplete in most contexts.
   - Follows Zena's existing conventions (see `classes.md` § 9).

2. **No Symbol**: Unlike JavaScript, Zena doesn't have Symbols. The `_` prefix provides similar "hidden but accessible" semantics within Zena's type system.

3. **Synchronous Only (Initially)**: Async disposal can be added later when Zena supports async/await.

### 4.2. The `using` Declaration

```typescript
{
  using file = openFile('data.txt');
  let data = file.read();
  // ...
} // file._dispose() called here
```

**Semantics:**

1. **Block-Scoped**: The resource is disposed when exiting the enclosing block.

2. **Immutable Binding**: `using` declares an immutable binding (like `let`), preventing reassignment that could leak resources.

3. **Type Requirement**: The initializer must be `Disposable` (or `null`—see below).

4. **Disposal Order**: Multiple `using` declarations dispose in reverse order (LIFO).

5. **Early Exit**: Disposal occurs on any exit: normal completion, `return`, or (future) exceptions.

### 4.3. Nullable Disposables

Resources may conditionally exist:

```typescript
{
  using file = maybeOpenFile(); // Returns File | null
  if (file != null) {
    // use file
  }
} // _dispose() called only if file != null
```

**Implementation**: The compiler generates a null check before calling `_dispose()`.

### 4.4. Code Generation

For a `using` declaration:

```typescript
{
  using resource = acquireResource();
  doWork(resource);
}
```

The compiler generates equivalent code:

```typescript
{
  let resource = acquireResource();
  try {
    doWork(resource);
  } finally {
    if (resource != null) {
      resource._dispose();
    }
  }
}
```

**Note**: This assumes Zena will eventually have `try`/`finally`. For now, we can implement this with a simpler transformation that inserts disposal calls at all exit points.

### 4.5. WASM Implementation

At the WASM level:

1. **Block Exit Points**: The compiler identifies all exit points from the block containing `using` declarations.

2. **Disposal Calls**: At each exit point, emit calls to `_dispose()` for all `using` variables in scope (reverse order).

3. **Virtual Dispatch**: Since `_dispose()` is an interface method, it uses the standard interface dispatch mechanism (fat pointers, VTable lookup).

## 5. DisposableGroup

For managing multiple resources or dynamic resource sets, we provide `DisposableGroup`:

```typescript
class DisposableGroup implements Disposable {
  #resources: Array<Disposable> = #[];

  use<T extends Disposable>(resource: T): T {
    this.#resources.push(resource);
    return resource;
  }

  adopt(cleanup: () => void): void {
    this.#resources.push(new CallbackDisposable(cleanup));
  }

  _dispose(): void {
    // Dispose in reverse order
    for (var i = this.#resources.length - 1; i >= 0; i = i - 1) {
      this.#resources[i]._dispose();
    }
    this.#resources = #[];
  }
}

// Helper for arbitrary cleanup callbacks
class CallbackDisposable implements Disposable {
  #callback: () => void;
  
  #new(callback: () => void) {
    this.#callback = callback;
  }
  
  _dispose(): void {
    this.#callback();
  }
}
```

### 5.1. Usage Examples

**Managing Multiple Resources:**

```typescript
{
  using group = new DisposableGroup();
  
  let file1 = group.use(openFile('a.txt'));
  let file2 = group.use(openFile('b.txt'));
  
  // Work with files...
} // Both files disposed (file2 first, then file1)
```

**Dynamic Resource Acquisition:**

```typescript
{
  using group = new DisposableGroup();
  
  for (var i = 0; i < fileNames.length; i = i + 1) {
    let file = group.use(openFile(fileNames[i]));
    processFile(file);
  }
} // All files disposed in reverse order
```

**Arbitrary Cleanup:**

```typescript
{
  using group = new DisposableGroup();
  
  let tempDir = createTempDir();
  group.adopt(() => deleteTempDir(tempDir));
  
  // Work with temp directory...
} // deleteTempDir called on exit
```

### 5.2. Name Choice: DisposableGroup vs DisposableStack

We prefer `DisposableGroup` over JavaScript's `DisposableStack` because:

1. **Clearer Intent**: "Group" implies a collection of related resources managed together.
2. **Less Technical**: "Stack" implies implementation details (LIFO data structure).
3. **Consistency**: Users think "group these resources for cleanup" rather than "push onto a stack."

The internal behavior is still stack-like (LIFO disposal), but the name emphasizes the use case over the mechanism.

## 6. Visibility and Namespacing

### 6.1. The Problem

The issue raises concerns about the visibility of disposal methods:

1. **Not Too Public**: Users shouldn't accidentally call `_dispose()` directly.
2. **Not Too Hidden**: The mechanism needs to be accessible for implementation.
3. **IDE Behavior**: Methods should be hidden from autocomplete in most contexts.

### 6.2. The Solution: Protected Access (`_` Prefix)

Zena's protected member convention (see `docs/design/classes.md` § 9) is a good fit:

1. **`_dispose()` is protected**: Accessible within the class, subclasses, and the defining module.

2. **`using` has special access**: The compiler-generated disposal calls have implicit access to protected members (similar to how `super` works).

3. **IDE Filtering**: IDEs can filter out `_` prefixed members from autocomplete by default.

4. **Documentation**: Protected methods can be marked with documentation conventions (e.g., `@internal` or `@protected` annotations).

### 6.3. Future: Symbol-Like Privacy

If Zena later adds a symbol-like mechanism, we could migrate to:

```typescript
// Hypothetical future syntax
const disposeSymbol = Symbol('dispose');

interface Disposable {
  [disposeSymbol](): void;
}
```

This would provide true namespacing. However, the `_` prefix is sufficient for the initial implementation and matches existing Zena conventions.

## 7. Type System Integration

### 7.1. Static Warnings

The compiler can emit warnings for common mistakes:

```typescript
let file = openFile('data.txt'); // Warning: Disposable not used with 'using'
// ...
// file._dispose() never called
```

**Implementation**: During type checking, if a variable's type implements `Disposable` and isn't declared with `using`, emit a warning.

### 7.2. `MustDispose` Marker (Optional)

For critical resources, we could add a stronger marker:

```typescript
interface MustDispose extends Disposable {}

class CriticalResource implements MustDispose {
  // ...
}

// This would be an ERROR, not just a warning
let resource = new CriticalResource(); // Error: MustDispose requires 'using'
```

This is optional and can be added later based on user feedback.

### 7.3. Return Type Handling

Functions returning disposables should consider whether the caller is responsible for disposal:

```typescript
// Factory function - caller is responsible
const openFile = (path: string): File => { ... };

// Method returning self - caller is NOT responsible
class Builder implements Disposable {
  addItem(item: Item): Builder {
    // ...
    return this; // No warning - returning existing disposable
  }
}
```

**Heuristic**: Returning `this` or an already-bound disposable shouldn't trigger warnings.

## 8. Exception Handling Interaction

### 8.1. Current State (No Exceptions)

Zena currently doesn't have exceptions. The `using` mechanism works by inserting disposal calls at:

1. Normal block completion
2. `return` statements
3. Any other control flow exit (future: `break`, `continue` with labels)

### 8.2. Future Exception Support

When Zena adds exceptions, `using` should integrate with `try`/`finally`:

```typescript
{
  using file = openFile('data.txt');
  riskyOperation(); // May throw
} // file._dispose() called even if exception thrown
```

**Error During Disposal:**

If `_dispose()` itself throws, and we're already handling an exception:

1. **Option A (Java-style)**: Suppress the disposal exception, attach it to the primary.
2. **Option B (Simple)**: Let the disposal exception propagate, losing the primary.

Recommendation: **Option A** for robustness. Implement a `SuppressedException` mechanism or similar.

## 9. Implementation Plan

### Phase 1: Core Infrastructure

1. **Define `Disposable` Interface**: Add to standard library prelude.
2. **Implement `using` Parser**: New keyword, similar to `let` declaration.
3. **Implement `using` Type Checker**: Verify initializer is `Disposable | null`.
4. **Implement `using` Codegen**: Insert disposal calls at block exits.

### Phase 2: Standard Library

1. **Implement `DisposableGroup`**: In standard library.
2. **Implement `CallbackDisposable`**: Helper class.
3. **Add Disposable Wrappers**: For host resources (file handles, etc.).

### Phase 3: Tooling

1. **Lint Warnings**: Warn on unused disposables.
2. **IDE Support**: Filter `_` members, show hints.

### Phase 4: Advanced Features

1. **`MustDispose` Marker**: Optional stronger enforcement.
2. **Async Disposal**: `AsyncDisposable` and `await using`.
3. **Exception Integration**: Proper `finally` semantics.

## 10. Summary

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Opt-in vs Automatic | **Opt-in (`using`)** | GC doesn't support deterministic destruction |
| Interface Name | `Disposable` | Matches JS/C# conventions |
| Method Name | `_dispose()` | Protected visibility, IDE-friendly |
| Stack Utility | `DisposableGroup` | Clearer than "Stack" |
| Forgetting Hazard | Lint warnings + optional `MustDispose` | Balance between safety and ergonomics |
| Visibility | Protected (`_` prefix) | Existing Zena convention |

## 11. Open Questions

1. **Naming**: Should the method be `_dispose()`, `_close()`, or `_cleanup()`? 
   - Recommendation: `_dispose()` for consistency with C#/JS terminology.

2. **Async**: When async is added, should we have `AsyncDisposable` with `_disposeAsync()`?
   - Recommendation: Yes, following the C#/JS pattern.

3. **Inheritance**: Can a class override `_dispose()` from a parent?
   - Recommendation: Yes, with `super._dispose()` calls encouraged.

4. **Multiple Disposal**: What happens if `_dispose()` is called twice?
   - Recommendation: Implementations should be idempotent (safe to call multiple times).

## 12. References

- [TC39 Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management)
- [C# IDisposable Pattern](https://docs.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-dispose)
- [Python Context Managers](https://docs.python.org/3/reference/datamodel.html#context-managers)
- [Rust Drop Trait](https://doc.rust-lang.org/std/ops/trait.Drop.html)
- [Java try-with-resources](https://docs.oracle.com/javase/tutorial/essential/exceptions/tryResourceClose.html)
