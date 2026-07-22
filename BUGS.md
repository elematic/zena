# Known Bugs

This file tracks known bugs as a lightweight alternative to GitHub issues.
When you encounter a bug during development, add it here rather than
immediately trying to fix it (which can pollute the current task's context).

## Format

```
### [Short description]
- **Found**: [Date]
- **Severity**: [low/medium/high/blocking]
- **Workaround**: [if any]
- **Details**: [description of the bug and how to reproduce]
```

## Active Bugs

### Mixin private names collide with host-class privates (semantics gap)
- **Found**: 2026-07-22
- **Severity**: medium (silent state corruption when names collide)
- **Workaround**: avoid giving a host class a private field with the
  same name as any private in an applied mixin.
- **Details**: A mixin's private member and a host class's same-named
  private collapse into ONE members-map entry and one struct field, so
  mixin code and host code mutate each other's "private" state, and
  the mixin's field initializer clobbers the host's:

  ```zena
  mixin Counter {
    var #count: i32 = 0;
    bump(): i32 { this.#count += 1; return this.#count; }
  }
  class HostB with Counter {
    var #count: i32 = 100;
    new();
    hostCount(): i32 { return this.#count; }
  }
  // new HostB(): bump(); hostCount() returns 1 — expected 100.
  ```

  Both compilers and backends agree (the collapse happens in the
  members map before codegen), and no execution test covered mixin
  privates until tests/language/execution/mixins/private_names.zena
  pinned the current behavior.

  INTENDED SEMANTICS (per review discussion): private names are
  lexically scoped to the mixin, shared across applications — like
  classes, and unlike the JS mixin pattern where each application is a
  fresh class with unshared private brands. Code written in the mixin
  sees the mixin's #x in every application; host code sees the host's
  #x; the two never alias. Implementation sketch: namespace mixin
  private members distinctly in the members map (e.g. keyed by mixin
  identity), mangle their struct fields with the MIXIN's key
  (Counter::#count) while host privates keep the class key, and
  resolve private accesses by lexical origin — the struct-driven
  resolver from the ZIR work (WasmStruct.resolvePrivateFieldName)
  extends naturally once the mixin is representable as a declaring
  scope. Checker-first change; both backends inherit it.


### Checker does not narrow after calls to never-returning functions
- **Found**: 2026-07-21
- **Severity**: low (ergonomics; forces redundant casts)
- **Workaround**: inline `throw`, or keep an `as` cast after the guard.
- **Details**: An inline `throw` in a guard branch narrows the guarded
  binding afterward, but a call to a function declared `: never` does
  not terminate control flow for narrowing purposes:

  ```zena
  let bail = (msg: String): never => { throw new Error(msg); };

  let f = (b: Box | null): i32 => {
    if (b == null) { throw new Error('x'); }
    return b.x;                      // OK: narrowed
  };
  let g = (b: Box | null): i32 => {
    if (b == null) { bail('x'); }
    return b.x;                      // Error: "Object may be null"
  };
  ```

  The ZIR lowering code is full of `#bail(...): never` guards followed
  by `as` casts that would all disappear if never-returning calls were
  treated like throw for reachability/narrowing. Both compilers agree
  (checked with the bootstrap checker).


### Host mutations after a read-only capture are invisible to the closure
- **Found**: 2026-07-21
- **Severity**: medium
- **Workaround**: mutate the variable somewhere inside a closure that
  captures it (forcing cell capture), or restructure so the closure reads
  state through an object field.
- **Details**: A captured variable is only heap-celled when a CLOSURE
  mutates it (`mutableCaptures` / `wasm.mutableCapturedSymbols` track
  closure-side assignments only). If only the HOST mutates the variable
  after creating a read-only closure over it, the closure keeps a by-value
  copy from creation time:

  ```zena
  export let main = (): i32 => {
    var x = 10;
    let read = (): i32 => x;
    x = 42;
    return read();  // returns 10; expected 42
  };
  ```

  Both compilers agree (bootstrap and self-hosted, streaming and ZIR
  backends — all consume the same capture analysis), so this is a
  checker/semantic-model bug, not a codegen one: the celling predicate
  should be "captured AND mutated anywhere", not "mutated by the
  closure". Fixing it in the capture analysis fixes every backend at
  once; it is a user-visible semantics change (currently diverges from
  JS-style closure capture), so it deserves its own change with tests.
  Pinned (at the current shared behavior, with a comment) in
  tests/language/execution/closures/celled_captures.zena.

### Self-hosted codegen fails member access on &&-narrowed values
- **Found**: 2026-07-21
- **Severity**: medium
- **Workaround**: hoist the narrowing to a statement (`if (x is T) {
  ... x.member ... }`) or use an explicit cast after the `is` test.
- **Details**: `x is T && x.member ...` — the checker narrows `x` in the
  right-hand side of `&&`, and the BOOTSTRAP codegen compiles it, but the
  SELF-HOSTED streaming codegen resolves `x.member` against the
  unnarrowed declared type and throws at compile time ("Could not find
  property `member` or virtual getter get#`member` on class ...").
  Found in build:self-hosted when compiler source used
  `vt is ValTypeRef && vt.target is WasmStruct`; the generateMemberExpression
  path in zena/lib/codegen/expr/member.zena uses the node's declared type
  where the bootstrap consults the narrowed type. Statement-level `is`
  narrowing (including member access in the if-body) works in both.


### Self-hosted checker does not surface inherited members on sealed variant types

- **Found**: 2026-07-19
- **Severity**: medium
- **Workaround**: type the value as the sealed base (`let a: Ty = new Leaf(); a.uid`)
- **Details**: Given `sealed class Ty { uid: i32 = next(); case Leaf }`, the
  bootstrap accepts `new Leaf().uid`, but the self-hosted checker reports
  "Property 'uid' does not exist on type 'Leaf'". Found while writing
  tests/language/execution/case-classes/unit-variant-inherited-initializer.zena,
  which uses the workaround.

### Compilers diverge on synthesized case-class hashCode overriding an explicit base hashCode

- **Found**: 2026-07-18
- **Severity**: low
- **Workaround**: Don't rely on exact hashCode values for case-class leaves under a sealed base that declares its own hashCode; both compilers are internally consistent with the hash/eq contract.
- **Details**: When a sealed base declares a concrete `hashCode()` and a case
  leaf has case params, the bootstrap compiler synthesizes a structural
  `hashCode()` on the leaf that overrides the base's, while the self-hosted
  compiler keeps dispatching to the base implementation. See
  `tests/language/execution/case-classes/sealed-base-hashcode-override.zena`
  (which only asserts the shared behavior) and the bootstrap-only test in
  `packages/compiler/src/test/codegen/case-class-hash_test.ts`. The language
  should pick one semantic — arguably an explicitly declared (inherited)
  hashCode should suppress synthesis. Relatedly, the self-hosted compiler
  creates singleton case instances before module-level `var` initializers run,
  so field initializers that read globals see their defaults.

### No syntax for constant byte arrays / data segments

- **Found**: 2026-02-25
- **Severity**: low
- **Workaround**: Use `String.copyBytesTo()` to copy from a string literal, or call `__byte_array_set` for each byte
- **Details**: When you need a constant byte array (e.g., for the string "-2147483648" in number conversion), there's no clean way to express it. Options to consider:
  1. Byte array literals: `let bytes: ByteArray = [45, 57, 50, ...];`
  2. Compile-time string-to-bytes: `@bytes("-9223372036854775808")`
  3. Named data segments with `data` keyword

  Currently we work around this by using `String.copyBytesTo()` which works but allocates a String object unnecessarily.

### Self-referential single-parameter generic class causes recursive type substitution

- **Found**: 2026-02-16
- **Severity**: medium
- **Workaround**: Use a wrapper class (e.g., `Set<T>` wrapping `Map<T, Unit>` instead of having its own `SetEntry<E>` class)
- **Details**: When a generic class with a single type parameter has a field referencing itself (e.g., `SetEntry<E>` with `next: SetEntry<E> | null`), and this class is used from another generic class (e.g., `Set<T>` using `SetEntry<T>`), the type checker incorrectly performs recursive type substitution. The error message shows nested types like `SetEntry<SetEntry<SetEntry<T> | null> | null> | null` instead of the correct `SetEntry<T> | null`. This bug does not occur with multi-parameter generics (e.g., Map's `Entry<K, V>` works fine).

### Local class declaration doesn't shadow built-in `Symbol` type

- **Found**: 2026-02-14
- **Severity**: medium
- **Workaround**: Rename the class to avoid collision (e.g., `SymbolEntry` instead of `Symbol`)
- **Details**: When you declare `class Symbol` in a module, it should shadow the built-in `Symbol` type within that module's scope. Instead, references to `Symbol` still resolve to the built-in type, causing errors like "Property 'name' does not exist on type 'Symbol'". This affects any class name that collides with built-in types.

## Fixed Bugs

### Stack overflow in emitter for large WASM output

- **Found**: 2026-02-15
- **Fixed**: 2026-02-16
- **Severity**: high
- **Fix**: Changed `buffer.push(...content)` to a for loop in `#writeSection` to avoid spread operator stack overflow.
- **Details**: The `#writeSection` method in emitter.ts used `buffer.push(...content)` which expands large arrays into individual function arguments. For ~140KB WASM files, this meant ~140,000 arguments on the call stack, causing stack overflow. The fix uses a for loop instead.

### WASM validation error: eqref vs specific ref type in closure wrappers

- **Found**: 2026-02-12
- **Fixed**: 2026-02-13
- **Severity**: high
- **Details**: Closure wrappers taking `eqref` weren't casting to specific ref types before calling the wrapped function.

### Nested generic type parameter resolution in codegen

- **Found**: 2025-01-XX
- **Fixed**: 2026-02-12
- **Severity**: medium
- **Fix**: Resolve type arguments through the enclosing context's type arguments before instantiating a generic function. This handles the case where a generic function is called from within a generic class method.
- **Details**: When a generic class method calls a generic function (like `some<T>(value)`) where `T` is resolved to the outer class's type parameter `V`, the codegen failed with "Unresolved type parameter: V, currentTypeArguments keys: [T]". This happened because the inner function's type context didn't have visibility into the outer class's type arguments.

### Nullable type in exported type alias causes WASM validation error

- **Found**: 2026-02-11
- **Fixed**: 2026-02-11
- **Fix**: Widen record/tuple literals to match function return types, not just variable declarations

### Wasm compiler fails to emit `ref.cast` when reading a local that was narrowed by an `is` check

- **Found**: 2026-05-31
- **Severity**: high
- **Workaround**: Explicitly assign to a new local instead of overriding: `let classType = unnarrowedType as ClassType;`
- **Details**: When a variable is narrowed by `if (x is ClassType)`, the Zena type system treats it as narrowed logic-wise, but the underlying Wasm local remains its original generic uncasted type (e.g. `(ref null $Type)`). The bootstrap compiler does not inject dynamic `ref.cast` when later reading this variable to evaluate a property access. Wasm compilation fails with: `type mismatch: expected (ref null $ClassType), found (ref null $Type)`. Assigning it explicitly circumvents the flaw.
