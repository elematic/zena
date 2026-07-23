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

### Parsers diverge on super() position in constructor init lists
- **Found**: 2026-07-22 (bootstrap side surfaced by CI run #32)
- **Severity**: low (divergence; each compiler is self-consistent)
- **Workaround**: write super() last — both compilers accept that.
- **Details**: The grammar (and the bootstrap parser, parser.ts
  ~3275) requires super(...) as the FINAL init-list entry, but the
  self-hosted parser accepts it anywhere: `new() : super(), y = 2;`
  parses, compiles, and runs correctly under the self-hosted
  compiler while the bootstrap rejects it with "Expected '{' before
  method body. Got Comma". Either the grammar should relax (and the
  bootstrap follow) or the self-hosted parser should enforce
  super-last. Decide, then pin with a semantics test.

### Mixin method bodies are re-typed per application on shared AST nodes
- **Found**: 2026-07-22 (while fixing the mixin private field collision)
- **Severity**: medium (latent miscompile risk; blocks node-type reasoning)
- **Workaround**: none needed for privates (WasmFunction.privateScopeKey
  bypasses node types); avoid type-divergent host-dependent typing in
  mixin bodies.
- **Details**: A mixin's body AST is shared by every application, but
  the checker re-checks it per application and setNodeType overwrites
  the shared nodes — observed directly: getNodeType(this) inside a
  mixin method returned the HOST class (e.g. HostA), not the mixin's
  synthetic This. Consequences: (1) codegen cannot derive lexical
  identity from node types for mixin code (why the private-field fix
  stores the scope on WasmFunction instead); (2) if two applications
  give a mixin-body expression genuinely different types (e.g. via
  the on-type), the LAST application's types win for every copy —
  a latent wrong-types miscompile for earlier copies. Consider
  per-application node-type maps for mixin bodies, or checking mixin
  bodies once against This like classes.

### No narrowing from destructured tuple elements
- **Found**: 2026-07-21 (repeatedly, writing compiler code)
- **Severity**: low (ergonomics; forces if-let or casts)
- **Workaround**: destructure inside the condition:
  `if (let (true, v) = map.get(k)) { ... }`.
- **Details**: `let (found, v) = map.get(k); if (found) { use(v) }`
  does not narrow `v` — its type stays `T | _` even though the tuple
  type correlates the arms. The if-let form narrows fine. Correlated
  narrowing of tuple elements after destructuring would make the
  common two-step pattern usable.

### Compilation cache is not invalidated when the compiler changes
- **Found**: 2026-07-21 (stale-cache runs masked real regressions)
- **Severity**: medium (green test runs against a stale compiler)
- **Workaround**: `rm -rf .zena/cache` before any suite run that
  follows a compiler rebuild (all our gates do this manually).
- **Details**: .zena/cache keys entries by source content (e.g.
  private-fields-generic_<hash>.wasm) but not by the compiler binary
  that produced them, so after rebuilding the compiler, cached
  modules from the previous compiler are served as hits. This masked
  a super-fields miscompile during the ZIR work (suite stayed green
  off stale artifacts) and makes any checker/codegen change
  unverifiable without manual cache clearing. The cache key should
  include a compiler build fingerprint (e.g. hash of cli.wasm /
  zena-cli).

### Cross-arm member access on non-null unions is unimplemented
- **Found**: 2026-07-22 (ruled desired behavior)
- **Severity**: low (ergonomics; forces narrowing)
- **Workaround**: narrow to an arm before accessing.
- **Details**: member-lookup.md §3 specifies that member access on a
  union is valid when every arm supports the member (result = union
  of per-arm member types; per-arm overload selection for calls),
  with null just an arm that supports no members. The checker
  currently only handles the null arm (plain access errors, ?. works)
  and rejects member access on multi-arm unions entirely.

### Static and instance members share one namespace in the implementation
- **Found**: 2026-07-22
- **Severity**: low
- **Workaround**: avoid same-named static and instance members.
- **Details**: member-lookup.md §2.2 specifies statics as their own
  namespace (a map on the class, vs instance members on instances),
  so the same name may exist in both. The implementation stores both
  in one members map with an isStatic flag, so they collide.

### Cross-kind member collisions are not uniformly diagnosed
- **Found**: 2026-07-22
- **Severity**: low
- **Workaround**: none needed; avoid same-named members of different
  kinds.
- **Details**: member-lookup.md §2.1 specifies one instance-member
  namespace per class — declaring one name as two kinds (field vs
  method vs accessor) is a collision error. The implementation's
  lookup probes field -> method -> getter, which acts as a silent
  precedence instead of an error.

### Overload selection does not implement the ruled semantics yet
- **Found**: 2026-07-22 (ruling date)
- **Severity**: medium (spec/implementation divergence; silent
  shadowing of more-specific overloads until migrated)
- **Workaround**: order overloads most-specific-first in source.
- **Details**: member-lookup.md §5.1 ruled for MOST-SPECIFIC
  selection with an overlap restriction on subclass-added overloads
  (declaration-site overlap error, call-site ambiguity error). The
  checker still implements declaration-order first-match, and the
  override-reorder wrinkle (member-lookup.md §5.3) is live. Migration
  touches only the candidate-choice step in checkCallExpressionInner
  and resolveIndexType — the setResolvedOverload recording contract
  and per-signature slots are unaffected. Update the two pinned tests
  when migrating: classes/overload-declaration-order.zena (1130 ->
  2130) and classes/overload-override-reorder.zena (120 -> 2020).

### Interface methods with the same name silently overwrite each other
- **Found**: 2026-07-22
- **Severity**: medium (silent wrong types; no diagnostic)
- **Workaround**: don't declare same-named methods in an interface.
- **Details**: Interface member registration assigns
  `ifaceType.members[name]` without checking for an existing entry
  (checker.zena `registerInterface` method loop), so the last
  declaration wins and earlier signatures vanish without any error.
  Interface overloads aren't supported (member-lookup.md §9.1); until
  they are designed, a duplicate name should be a checker error.

### Bodyless method in a regular class becomes a silent empty body
- **Found**: 2026-07-22
- **Severity**: medium (silent wrong behavior for a natural mistake)
- **Workaround**: always write method bodies in non-declare classes.
- **Details**: The parser treats `foo(x: A);` in a non-abstract,
  non-declare class as a method with an empty block body
  (parser.zena, Semi branch of method parsing). Anyone writing
  TypeScript-style "signature list + one implementation" overloads
  gets real empty-body overloads that return zero values, selected by
  normal overload resolution (member-lookup.md §9.2). Should be a
  parse or check error.

### Tear-off of an overloaded method silently picks the first signature
- **Found**: 2026-07-22
- **Severity**: low (overloaded tear-offs are rare so far)
- **Workaround**: wrap in a lambda: `let f = (x: i32) => p.print(x);`.
- **Details**: `let f = obj.method` where `method` is overloaded
  returns the primary (first-declared) `FunctionType` with no
  diagnostic and no use of the expected type (`resolveMemberType`
  MethodInfo path; `setResolvedOverload` is only called from call and
  index resolution). Spec is context-sensitive resolution with an
  ambiguity error when no context exists (member-lookup.md §7/§9.3).


### Self-hosted checker does not narrow a loop var through a compound while condition
- **Found**: 2026-07-22
- **Severity**: low (forces redundant casts; bootstrap accepts the code)
- **Workaround**: cast inside the loop body (`(r as ClassType).x`).
- **Details**: The bootstrap checker narrows `r` in the body of
  `while (r != null && !done) { r.member; r = r.next; }` for
  `var r: T | null`; the self-hosted checker reports "Object may be
  null", a checker divergence. Hit in checker.zena's private-access
  receiver walk (see the "no narrowing through compound while"
  comment there).

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

### Private grouped accessors broken in every compiler
- **Found**: 2026-07-23; **Fixed**: 2026-07-23
- **Details**: `#name: T { get {...} set(v) {...} }` was broken
  differently everywhere: the self-hosted parser rejected the
  accessor block after a private field name; the bootstrap parsed it
  but its checker's private gate (fields/methods maps only) rejected
  every access, its assignment codegen had no private-setter path,
  and both mixin checkers never type-checked mixin accessor bodies
  (self-hosted) or misregistered them as bare fields (both). Where
  they DID compile, private accessors dispatched virtually through
  vtable slots. Now: private accessors parse, register as get#/set#
  methods only (no phantom bare-name field), never get vtable slots,
  and dispatch directly and lexically — subclass shadowing and
  host/mixin same-name coexistence work, with mixin private
  accessors under the mixin scope key. Pinned by
  classes/private-accessors.zena (10102),
  classes/private-accessors-lexical.zena (12), and
  mixins/private_accessors.zena (100900) on all compiler/backend
  combos.

### Mixin private methods collide with host-class private methods; streaming dispatched privates virtually
- **Found**: 2026-07-23; **Fixed**: 2026-07-23 (all compilers)
- **Details**: Two related bugs. (1) A mixin's private method and a
  host class's same-named private method collapsed into one dispatch
  slot in ALL THREE compilers (self-hosted streaming/ZIR and the
  bootstrap), so mixin code calling this.#word() ran the host's
  method. Fixed by extending the mixin private scope key to methods:
  the checker stores mixin private MethodInfo under
  "<scope>::#name", registration registers them per host under the
  scoped name, and the private-call paths probe the calling
  function's privateScopeKey first. (2) The self-hosted streaming
  backend gave private methods vtable slots and dispatched them
  virtually — a subclass's shadowing #m hijacked the parent's
  this.#m() (ZIR and the bootstrap were already lexical). Privates
  now get no vtable slot anywhere and are always direct-called
  lexically; the bootstrap's mixin-intermediate vtable gets the same
  "#" exclusion its plain classes already had. Pinned by
  mixins/private_methods.zena (11111400),
  classes/private-methods-lexical.zena (12), and
  classes/private-methods-generic.zena (41) on all compiler/backend
  combos.

### Mixin private fields collide with host-class privates
- **Found**: 2026-07-22; **Fixed**: 2026-07-22 (self-hosted; the
  bootstrap never collided)
- **Details**: A mixin's private field and a host class's same-named
  private collapsed into one members-map entry and one struct field
  in the self-hosted compiler, so mixin and host code silently
  mutated each other's state. Fixed with a private scope key: the
  checker stores mixin private fields in host members maps under
  "<scopeKey>::#name" where the scope key is the mixin's name plus
  its source path (the MixinKey identity — names alone are not
  unique; composed mixins keep the inner mixin's scope), codegen
  names struct fields identically, functions compiled
  from mixin bodies carry WasmFunction.privateScopeKey and resolve
  "#" fields under it in both backends. Mixin privates are lexical to
  the mixin declaration and shared across applications
  (member-lookup.md §6); same-named host/mixin privates coexist even
  with different types. Pinned by
  tests/language/execution/mixins/private_names.zena (3120, all
  compiler/backend combos).

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
