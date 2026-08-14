# Known Bugs

This file tracks known bugs as a lightweight alternative to GitHub issues.
When you encounter a bug during development, add it here rather than
immediately trying to fix it (which can pollute the current task's context).

## Format

```
### A local live across a try holding both an `await` and a `return` miscompiles
- **Found**: 2026-08-11 (writing the combinator tests; the shape is ordinary
  async code, not anything the combinators need)
- **Severity**: high, and NOT reliably loud (updated 2026-08-13): the
  same four ingredients can instead compile and then *silently skip the
  handler* — a throw inside the try escaped `catch (e)` and surfaced as
  an unhandled `WebAssembly.Exception` out of `main`. Seen writing the
  `zena:fetch` body-reads-once test (`await fetch(url)`, then
  `let first = await response.text()`, then a try whose second `text()`
  throws): minimal versions of that shape still fail verify loudly, but
  the longer real function slipped past the verifier and mis-ran. "A
  longer function with the same shape compiled fine" below was this,
  observed from the other side — compiling was not the good outcome.
  The workaround is therefore load-bearing for correctness, not just
  for getting past the verifier.
- **Details**: ZIR verification fails with
  `%N in bX uses %M from bY, which does not dominate it` for
  `main$…$AsyncFrame.step`. All four ingredients are needed:
  ```zena
  export async function main(): Future<i32> {
    let won = 70;                                  // (1) bound BEFORE the try
    try {
      await failedFuture<i32>(new Error('lost'));  // (2) an await inside it
      return 0 - 2;                                // (3) and a return inside it
    } catch (e) {
    }
    return won;                                    // (4) used AFTER the try
  }
  ```
  Drop the `return` at (3) and it compiles and runs; drop the local at (1)
  and (4) and it compiles and runs. The first await is *not* required —
  `let won = 70;` reproduces it as readily as `let won = await …`.
- **Fragile to trigger**: a longer function with the same shape compiled
  fine, so this is sensitive to surrounding SSA numbering rather than being
  a clean syntactic rule. Treat the four ingredients as necessary, not
  sufficient.
- **Related**: PR #186 ([[try cells]]) fixed try-*body*-assigned locals, and
  #196 fixed regions at every dispatch target. This is neither: the local is
  never assigned inside the try, only read after it.
- **Worked around**: `tests/language/execution/async/combinator_all.zena`
  and `combinator_race.zena` push the try/catch into a small async helper
  that returns from both arms, which has no local living across it.

### RESOLVED: `is` and downcasts always failed through an interface-typed reference
- **Found**: 2026-08-08 (designing zena:host-async's handle registry, which
  wanted to hold completers of different payload types in one map)
- **Fixed 2026-08-13.** One cause, three lowering sites. A value held as an
  interface is a fat POINTER — the instance paired with a vtable — so
  `ref.test` against the concrete struct asked whether the PAIR was a
  `Square`, which is false for every class, and `ref.cast` cast the pair and
  trapped. Identity compares already saw through it
  (`LoweringContext.unwrapFatPointer`, "Identity compares see through fat
  pointers"); `is`, `as`, and narrowed reads did not.
  - `#lowerIs` and `lowerAs` unwrap when the TARGET is a class.
    Interface-to-interface is deliberately untouched: whether an instance
    implements another interface is a question about vtables, and
    `ref.test` cannot answer it in either direction.
  - The third site is the one the first two exposed. After `c is Cell<i32>`
    the checker narrows `c`, so the read is typed `Cell<i32>` while the
    value in hand is still the pair — and a pair is not a subtype of the
    instance inside it, so the coercion bailed `identifier type shift`.
    `unwrapFatPointerValue` asks the question of the REPRESENTATION rather
    than of a semantic type, by reverse-scanning `wasm.interfaceStructs`,
    because that site has a lowered value and no type to consult.
- **Was severity high**: a wrong answer, not a rejected program.
- Specialization identity was never the problem — it works through a base
  class and now works through an interface: a `Cell<i32>` held as `Shape`
  tests true for `Cell<i32>` and false for `Cell<String>`, including for a
  specialization the program never constructs.
- **Test**: `execution/interfaces/downcast-through-interface.zena`.
- **Still worked around**: `zena:async`'s `AnyCompleter` is a base class
  rather than the marker interface it wants to be. That can be revisited
  now; it is a stdlib change rather than part of this fix.

### `match` over an interface-typed scrutinee calls the second arm unreachable

- **Found**: 2026-08-13, writing the regression test for the downcast fix
  above.
- **Severity**: medium. A rejected program rather than a wrong answer, but
  it rejects an ordinary shape and the diagnostic blames the wrong thing.
- **Details**: with `interface Shape` and two implementors,

  ```zena
  let named = match (s) {   // s: Shape
    case Square: 10
    case Circle: 20         // Unreachable case.
    case _: 30              // Unreachable case.
  };
  ```

  Both later arms are reported unreachable. `Shape` is not sealed, so
  nothing licenses treating `case Square` as exhaustive — the subtraction
  appears to consume the whole scrutinee type on the first class arm.
- **Not the same bug as the downcast one above**, and not fixed by it: this
  is exhaustiveness in the checker, and it rejects before lowering runs.
- **Workaround**: an if-chain of `is` tests, which is what the test does.

### RESOLVED: Self-hosted compiler cannot *call* a generic method on a class
- **Fixed**: 2026-08-10, "Stop emitting a generic method at its own
  erasure". A generic method was ALSO emitted unspecialized, with its
  own type parameters erased to anyref — given a class-vtable slot and
  force-reached per specialization of the class. The call site looks for
  `identity_spec_i32`, so the erased body served nobody: it was dead in
  every module that had it (80 such bodies in the compiler's own), and
  it was what "method not found" found instead of a specialization. A
  generic method now exists once per specialization and nowhere else,
  and `classes/generic-method.zena` is no longer skipped.
- **Found**: 2026-08-05 (wiring `wit-parser` into the package map; the
  self-hosted compiler could not build the WIT parser's own source)
- **Severity**: medium (no longer blocks `packages/wit-parser`)
- **Tests**: `tests/language/execution/classes/generic-method.zena`
  (unskipped), `generics/generic-method-specializations.zena`.
- **Details**: *Calling* a generic public method fails in ZIR with
  `zir unsupported: method not found @Box_s787.run`. Declaring one is fine —
  `tests/language/execution/classes/generic-loop-member.zena` has `fold<R>(…)`
  and runs under self-hosted today — but that method is never called, so no
  portable test covered the call path until now. Declaration coverage is not
  call coverage.
- **Fixed half**: this entry originally also covered generic *private*
  methods, which the parser rejected as private fields. Fixed by 0e7effe4;
  `classes/generic-private-method.zena` is no longer skipped. That was the
  half blocking the WIT parser (`Parser.#parseList<T>`).

### if-let accepts any refutable pattern but only inline tuples are implemented
- **Found**: 2026-07-31 (review question on #95: "if-let should work
  with any refutable pattern — do we need more coverage?")
- **Severity**: medium (checker-accepted syntax crashes codegen)
- **Deferred**: per review (2026-07-31), until bootstrap retirement so
  there would be one implementation instead of two. **Unblocked
  2026-08-06** — the bootstrap is deleted.
- **Workaround**: destructure through an inline-tuple shape, or use a
  match expression.
- **Details**: Both checkers accept non-tuple refutable patterns in
  let-conditions — `if (let Just {v} = maybe)` (class pattern on a
  sealed variant), `if (let {x} = unionOfRecords)` (record pattern) —
  but neither compiler implements them: the bootstrap fails these
  shapes, and ZIR's let-condition machinery expects an inline-tuple
  scrutinee (bails, which is a hard compile error). Every existing if-let/while-let test starts with an
  inline tuple; nested class/record patterns are covered only INSIDE
  tuples (`(true, Point {x, y})`). Either implement top-level
  refutable patterns in both compilers (ZIR's #83 pattern
  machinery — #lowerPatternTest/#lowerPatternBindings — has the
  pieces) or reject them in the checkers; then port the match-pattern
  test matrix to if-let/while-let either way.

### Method/field same-name semantics are unsettled
- **Found**: 2026-07-31 (review discussion on #87's field-closure calls)
- **Severity**: medium (silent acceptance with resolution divergence)
- **Deferred**: per review (2026-07-31), until bootstrap retirement so
  there would be one implementation to change instead of two.
  **Unblocked 2026-08-06** — the bootstrap is deleted.
- **Workaround**: none needed yet; ZIR refuses the ambiguous case
  (the bail is a hard compile error, so the shadowing declaration
  effectively cannot compile).
- **Details**: Members share one string-keyed namespace, but the
  interactions between function-typed FIELDS and METHODS are only
  half-settled:
  - A field of function type does NOT satisfy an interface method —
    both checkers reject ("incorrectly implements"). Pinned by
    tests/language/semantics/interfaces/
    field-does-not-implement-method.zena.
  - A field whose name shadows an inherited METHOD is accepted
    silently by the checkers, but no ruling defines what it means
    (the checker's member map for Derived says the FIELD; historical
    implementations disagreed). ZIR bails loudly ('field shadows
    inherited method') rather than pick a side, which is a hard
    compile error.
  - Needs a language ruling: reject the shadowing declaration
    outright (probably right — one namespace should mean one owner
    per name in a hierarchy), or define override semantics for
    fields implementing/overriding methods. Then execution tests for
    whichever ruling lands, and the ZIR bail becomes either a checker
    diagnostic or a real lowering.

### [Short description]
- **Found**: [Date]
- **Severity**: [low/medium/high/blocking]
- **Workaround**: [if any]
- **Details**: [description of the bug and how to reproduce]
```

## Active Bugs

### `static` on an accessor is dropped by the parser

- **Found**: 2026-08-11, writing the rule that a static may not name its
  class's type parameters. The accessor arm of that rule never fired.
- **Severity**: low. Nothing declares a static accessor today.
- **Details**: `parser.zena` builds every `AccessorDeclaration` with
  `isStatic` hardcoded to `false`, so `static` in front of one parses and
  is then silently discarded. The accessor registers as an *instance*
  member; naming it through the class still passes the checker and fails
  in lowering:

  ```zena
  class Plain {
    static var n: i32 = 5;
    static doubled: i32 { get { return Plain.n * 2; } }
  }
  Plain.doubled;   // zir unsupported: static member not found
  ```

  Two things are wrong: the parser drops the modifier, and static access
  to an instance member is not diagnosed. The second is the one that
  turns a parse bug into a codegen failure.
- **Note**: `rejectClassTypeParamsInStatic` already has the accessor arm,
  so the type-parameter rule starts working the moment `isStatic` is
  plumbed through. It is untested until then.
- **Workaround**: use a static method.

### A mixin's `static` members are declared and then unreachable

- **Found**: 2026-08-11, while rejecting static fields typed by a generic
  class's `T`. Checking whether the same rule was needed for mixins turned
  up that mixin statics do not work at all.
- **Severity**: low. Nothing in the stdlib or the compiler declares one, so
  this is a hole rather than a regression.
- **Details**: the checker accepts the declaration and then rejects every
  way of naming it. Not specific to generics — a plain mixin does the same:

  ```zena
  mixin Pool {
    static var items: i32 = 0;
    static size(): i32 { return Pool.items; }
    //                          ^ Property access not supported on type 'Pool'.
  }
  ```

  `checkMixinDeclaration` registers a `FieldInfo`/`MethodInfo` carrying
  `fd.isStatic` into `mixinType.members`, so the member exists; what is
  missing is static access *through a mixin name* in
  `checkMemberExpression`, which handles `ClassType` receivers only.
- **Open question worth settling first**: whether a mixin static should be
  one cell on the mixin, or one per host class that mixes it in. Mixins are
  copied into their hosts, so the second is closer to how the rest of the
  feature behaves — and it is the same shared-storage question that made
  `static var stored: Array<T>` an error on a generic class.
- **Workaround**: put the static on the host class.

### A body specialized on its own type parameter cannot instantiate an interface implementation

- **Found**: 2026-08-12, checking which of `zena:async`'s shapes were
  still forced now that `86e63185` and the statics commits have landed.
  The restriction predates that work — it is why the combinators route
  construction through `AllState`/`RaceState` — but it had never been
  filed on its own.
- **Severity**: medium. Loud (a lowering bail, no wrong answers), but it
  dictates code structure: any generic factory that returns an interface
  has to be a method on some generic class, so the class exists to host
  the method rather than to hold anything.
- **Details**: a generic FUNCTION, or a `static` with its own type
  parameter, that constructs a class implementing an interface bails:

  ```
  zir unsupported: interface vtable global not found @make_spec_i32
  ```

  A generic CLASS's own method doing the same thing lowers fine. So what
  works depends on where the generic code lives, not on what it does.
  Test: `execution/generics/vtable-in-generic-fn.zena` (`@skip`ped, so
  it self-retires).
- **Not the same bug as** "A generic static's body cannot reach any
  generic construct" (RESOLVED below). That one was RTA walking a
  generic method's body with its type parameters still open; this one
  survives it — verified by inlining `RaceState.attach` into
  `Future.race` after the fix and getting this bail.
- **Workaround**: host the construction on a generic class's method, as
  `AllState.attach` and `RaceState.attach` do.

### A stdlib module's exported type names resolve without an import

- **Found**: 2026-08-10, typing a resource's `this` as `Borrow<R>`. I
  added a check that `Borrow` is in scope wherever a resource class is
  declared, and it never fired — including in files importing nothing at
  all from `zena:ownership`.
- **Severity**: medium. It is a silent fuzzy fallback of exactly the kind
  the project avoids elsewhere: a name resolves by being *somewhere* in
  the stdlib rather than by being brought into scope, so a typo or a
  forgotten import can bind to an unrelated type instead of failing.
- **Details**: not specific to ownership, and not an artifact of the
  batching test runner — it reproduces in a standalone `zena-cli run`:

  ```zena
  export function main(): i32 {
    let m: HashMap<String, i32> | null = null;   // no import of HashMap
    return if (m == null) 0 else 1;              // compiles, runs, prints 0
  }
  ```

  `CheckerContext.resolveTypeName` is `#materializeFromScope` then
  `#resolveBuiltinOrPreludeType`, and one of the two is answering for
  names that are neither in scope nor in the prelude.
- **Consequence worth noting**: `wrapResourceInOwn`'s
  "Add: import { Own } from 'zena:ownership';" diagnostic appears to be
  unreachable for the same reason, and nothing tests it. The design
  intent it encodes — `zena:ownership` is out of the prelude, so a file
  that names a handle must import it — is not actually enforced.
- **Workaround**: none needed today; imports are still written by
  convention.

### `resetWasmTypeUids` is a module-global plus a reset

- **Found**: 2026-08-07, turning on batch compilation.
- **Severity**: low today — `ModuleGenerator.compile` calls the reset
  first thing, and `multi-entrypoint-codegen_test.zena` guards that it
  keeps doing so. Blocking for a concurrent compiler, where two module
  passes in flight would share and restart one counter.
- **Details**: `_nextWasmTypeUid` in `codegen/wasm.zena` is module
  state, and `WasmType.uid` reads it from a field initializer. Since
  `uid` is `hashCode`, it orders every hash container keyed by a
  `WasmType`, and that order reaches the emitted bytes — which is why
  the reset exists at all. State whose lifetime is the compile belongs
  on the object with that lifetime (`WasmModule`, as #200 did for
  codegen's class caches, or `SharedCheckerState` as the node→model
  index now does). The obstacle is that a field initializer cannot see
  the module, so every `WasmType` construction site would have to be
  handed one.
- **Do not do the same to its sibling.** `_nextTypeUid` in
  `lib/types.zena` is the identical shape one level up — a module-global
  feeding `Type.uid`, which is `Type.hashCode` — but it must *not* be
  reset per compile. A long-lived compiler interns semantic types across
  compiles, so restarting that sequence would hand a fresh type the uid
  of a cached one, which is the node-id collision of #209 again in a
  different currency. The rule there is the other one: the order must
  not reach the output. `SymbolDependencies.referencedTypes` was a
  `HashSet<Type>` that RTA walked to intern wasm types and register
  function-value wrappers, so a module's bytes depended on how many
  modules preceded it in the process; it is an `OrderedTypeSet` now,
  iterating in the checker's insertion order, and
  `codegen-determinism_test.zena` guards it.

### Codegen emits a spurious value-wrapper

- **Found**: 2026-08-07, while fixing the multi-entrypoint codegen bug
  below.
- **Severity**: low — the wrapper is dead code. It is declared in the
  elem segment but nothing takes a `ref.func` to it, so the module is
  valid and behaves correctly.
- **Details**: `String.asciiLowerCase`/`asciiUpperCase` call
  `asciiLowerByte`/`asciiUpperByte` **directly**
  (`if (lower) asciiLowerByte(b) else asciiUpperByte(b)`), so neither
  needs a function-value wrapper. One is emitted anyway.
- **Fix**: `registerWrapper` in `codegen/reachability/visitor.zena` is
  reached for an identifier that is only ever a direct callee.
  Registering wrappers strictly from value uses would drop it.
- **Was also**: *which* of the two got the wrapper used to vary between
  compiles in one process. Exactly one spurious registration happens
  either way — `asciiUpperByte` gets no wrapper at all, despite
  identical usage — and hash order decided which function it landed on.
  Not a key collision: `FunctionValueWrapperKey` is
  `(symbolId, signatureKey)` with both fields in `==`, so the two never
  share a key. That half is fixed; see the `referencedTypes` note in the
  entry above.

### The checker reports 17 diagnostics twice

- **Found**: 2026-08-08, tightening the semantics runner's `@error`
  matching. The loose matcher could not see them: one directive was
  satisfied by either copy and the other copy went unclaimed, and
  unclaimed errors were ignored.
- **Severity**: low — the message is right, it is just emitted twice, at
  the identical file, line and column.
- **Where**: 17 sites across 10 semantics tests, listed by their doubled
  `@error:` directives — `inline_tuple_restrictions.zena` (5),
  `inline_tuple_alias_restrictions.zena` (3), `null-check-else.zena` (2),
  and one each in `methods-and-inference.zena`,
  `field-init-forward-ref.zena`, `immutable-field-init-required.zena`,
  `cannot-override.zena`, `no-param-annotations.zena`,
  `method-annotation-required.zena`, `invalid_inline_positions.zena`.
  Two look like distinct causes: an inline-tuple position is reported
  once per validation pass, and a class member is checked both on the
  declaration and on the member.
- **A third cause**, found 2026-08-10 adding the borrow storage rule: a
  `type` alias's annotation is resolved twice, so *every* diagnostic
  raised while resolving one is emitted twice. It is not particular to
  any check — `type Slot = {file: File};` on a resource class reports
  "has no unwrapped form" twice on the same line and column. It is why
  `semantics/ownership/borrow-is-not-stored.zena` spells its record case
  at a `let` rather than at a `type`: one directive there records the
  rule, where an alias would have needed two directives recording this
  bug instead.
- **Note**: those tests now carry a directive per copy, so they record
  what the compiler does. De-duplicating will fail them with
  `Expected error ... but found none there`, which is the signal to
  delete the second directive — not a regression.

### Six type checks the semantics tests expected and the checker does not make

- **Found**: 2026-08-08, tightening the semantics runner's `@error`
  matching. Each of these had a directive that had been passing against
  an unrelated error in the same file.
- **Severity**: medium — they are real holes in the type system, and
  they were being reported as covered.
- **Missing**:
  - `p1 != "hello"` where `p1` is a class instance is accepted, while
    `p1 == 1` is rejected — `!=` is not checked the way `==` is
    (`classes/operators/operator-eq.zena`).
  - `42 == null` and `null != true` are accepted
    (`operators/equality-type-check.zena`). Comparing a non-nullable
    operand against `null` looks like the null-check idiom and skips the
    incompatibility check.
  - `arr["string"]` and `arr["key"] = 42` do not check the key against
    the declared index-operator parameter type
    (`classes/operators/operator-index.zena`, `operator-index-set.zena`).
  - `Box<Box<i32>>` is not rejected for a function returning a
    deduplicated generic union
    (`generics/union-dedup-generic.zena`).
- **Tracking**: each site carries a `// @missing-error:` directive,
  which asserts the error is still *absent*. Implementing any of these
  fails its test with a message saying to promote the directive to
  `@error:`, so the marker retires itself.

### Default parameters are not applied to forward-referenced callees

- **Found**: 2026-08-07 (adding a second defaulted parameter to
  `resolveTypeAnnotation` in `checker.zena`)
- **Severity**: medium — it silently constrains how top-level functions can
  evolve, and the error blames the _call site_ rather than the declaration.
- **Details**: a top-level `let f = (…) => …` whose parameters have defaults is
  arity-checked as if the defaults were required when the call appears
  **lexically above** the definition. Adding a second defaulted parameter to
  `resolveTypeAnnotation` (declared ~line 2200, called from ~line 775) produced
  `Expected 4 arguments, got 3` at every earlier call site, while the same
  function shape compiles and runs correctly in isolation:

  ```zena
  let f = (a: i32, b: i32 = 1, c: i32 = 2): i32 => a + b + c;
  export let main = (): i32 => f(10) + f(10, 5);   // 13 + 17 = 30, correct
  ```

  The pre-existing single default on that function never exposed it, because
  every call passed all three arguments.

- **Workaround in place**: `checker.zena` carries `resourceMentionOk` as a field
  on `CheckerContext` instead of a parameter, with a comment pointing here.
- **Fix sketch**: the forward-reference path appears to record a signature from
  the declaration's parameter _count_ before default expressions are attached.
  Compare how arity is resolved for a call whose callee is already checked
  versus one resolved through the forward-declaration stub.

### A generic *function*'s callback parameter does not contextually type its closure

- **Found**: 2026-08-07 (writing execution tests for generic distinct-type
  aliases — a `map`-shaped helper over the alias hit it, and the alias turned
  out to be irrelevant)
- **Severity**: medium — it rules out the whole `map`/`fold`/`forEach` shape on
  free functions, which is where most of them naturally live.
- **Details**: when a generic free function takes a callback whose signature
  mentions the type parameter, an unannotated closure argument is checked with
  the parameter still unsubstituted:

  ```zena
  let apply = <T>(c: T, f: (v: T) => T): T => f(c);

  apply<i32>(19, (v) => v + 1);   // Error: cannot apply operator '+' to T and i32
  apply(19, (v) => v + 1);        // same, inferred or explicit alike
  ```

  Two neighbouring shapes are fine, which is what localizes it:

  ```zena
  apply<i32>(19, (v: i32) => v + 1);            // annotating the closure works
  new Box<i32>(19).run((x) => x + 1);           // a generic *method* works
  ```

  So the substituted parameter list is reaching the assignability check (the
  call is not rejected) but not the contextual type handed to the closure.
- **Fix sketch**: the call path substitutes `effectiveFt.parameters` into
  `subParams` before checking arguments, and the generic-method path already
  contextually types from the substituted signature. Compare the two — the free
  function path appears to contextually type each argument from the
  *pre-substitution* parameter type.
- **Tests**: none yet. `tests/language/execution/generics/generic_opaque_cell.zena`
  had a `map` written against this shape and it was cut back to first-order
  helpers; that is the test to restore with the fix.

### Inline tuples can be bound to a variable

- **Found**: 2026-08-06 (same investigation).
- **Severity**: low
- **Details**: `let x = f();` where `f` returns `inline (i32, i32)` is
  accepted. Inline tuples are return-position-only, so this should be an
  error, but the diagnostic is only ever emitted from
  `resolveTypeAnnotation`, and an inferred declaration has no annotation
  to resolve. Pinned (as a comment, not a directive) in
  `semantics/type-system/inline_tuple_restrictions.zena`.

### A `void` value can be bound to a variable

- **Found**: 2026-08-07 (making `void` usable as a type argument, which
  is what `Future<void>` needed).
- **Severity**: low (bad diagnostic, not a miscompile)
- **Details**: `let x = f();` where `f` returns `void` is accepted by the
  checker and only fails in ZIR with `zir unsupported: binding type`. It
  should be a type error at the declaration. Predates — and is
  independent of — `void` as a type argument: binding a plain
  void-returning call behaves identically. It is easier to hit now, because
  `c.get()` on a `Cell<void>` is an ordinary-looking call, so the late,
  cryptic failure is worth replacing with a real diagnostic. Pinned (as
  a comment, not a directive, since the runner would match the @error
  loosely) in `semantics/generics/void-type-argument.zena`. Same shape
  as "Inline tuples can be bound to a variable" above.

### The stdlib cannot use a new language feature until the seed is re-cut

- **Found**: 2026-08-06 (retiring the `ByteArray` primitive; the obvious
  implementation — `export type ByteArray = FixedArray<u8>;` in
  `packages/stdlib/zena/byte-array.zena` — fails to build).
- **Severity**: medium (not a miscompile; a bootstrapping constraint that
  is invisible until it bites, and whose error message points nowhere
  near the cause)
- **Symptom**: `zena:byte-array:13:37 - Error: Type 'u8' not found.`,
  followed by a cascade of `FixedArray<<error>>` mismatches across every
  module that touches the affected stdlib type. Nothing in the message
  suggests the _compiler binary_ is the problem.
- **Details**: `build:cli` compiles the compiler — and with it the whole
  stdlib — using the pinned seed at
  `packages/zena-compiler/bootstrap/cli.wasm`. The seed is a compiler
  from an earlier commit, so it only understands language features that
  existed when it was cut. Narrow integers had landed in the source
  tree, but the seed predates them, so stdlib _source text_ saying `u8`
  is unbuildable. Verified directly: the seed rejects `let b: u8 = 200;`
  while the freshly built compiler accepts it.
- **The asymmetry that makes this survivable**: the _compiler's own_
  source is under the same constraint, but it rarely trips, because the
  compiler refers to new types through its own classes (`new U8Type()`)
  rather than through the surface syntax (`u8`). A feature can therefore
  be implemented and used inside the compiler immediately, while the
  stdlib has to wait a release cycle. `ByteArray` was defined in the
  checker's prelude instead of the stdlib for exactly this reason.
- **Resolution when it does block you**: `npm run reseed -w
@zena-lang/zena-compiler` copies `zena/out/cli-self.wasm` over
  `bootstrap/cli.wasm`, gated on the full test suite passing. That is
  the intended mechanism, but it rewrites a checked-in 4MB binary that
  is the build's trust root, so it deserves its own commit and an
  explicit decision rather than being done in passing.
- **Worth considering**: nothing warns about this. A stdlib file using a
  too-new feature fails with a type-not-found error rather than
  something like "the pinned seed does not support `u8`; re-cut the seed
  or move the definition into the compiler". A note in
  `docs/design/bootstrapping.md` would be the cheap fix.

### A `for` loop whose body never falls through fails ZIR verification

- **Found**: 2026-08-12 (writing the `finally` execution tests; the shape
  turned up as a test fixture, not as anything `finally` introduced)
- **Severity**: medium (rejected at compile time, so it is loud, but the
  program is perfectly ordinary)
- **Details**: a C-style `for` whose body always leaves — an unconditional
  `break`, `continue`, `return` or `throw` at the end of it — leaves the
  update block with no predecessors, and `verifyIr` rejects the function
  with `bN is unreachable from the entry block`. No `try` is involved:

  ```zena
  export let main = (): i32 => {
    var n = 0;
    for (var i = 0; i < 5; i += 1) {
      n += 1;
      break;
    }
    return n;
  };
  ```

  `lowerFor` creates the update block up front and branches to it from the
  end of the body; when the body ends unreachable, nothing does. Either the
  update block should not be created, or the verifier's reachability check
  should run after a dead-block prune.
- **Workaround**: make the exit conditional, or use `while`.

### zena-cli cannot compile files outside the repository root

- **Found**: 2026-08-06 (repointing the nix flake's `zena` command at
  zena-cli during bootstrap retirement)
- **Severity**: low for development (in-repo files are the workflow),
  high for an _installable_ zena — `nix run .#zena` can only compile
  files under ZENA_REPO_ROOT
- **Details**: `compile_to_cache` requires the source under the repo
  root (`strip_prefix(repo_root)` — "File must be inside the Zena
  repository for now"), because the guest compiler's WASI view and the
  stdlib both resolve through that root. Supporting arbitrary paths
  means preopening the file's directory for the guest and mapping the
  entry path independently of the stdlib root.
- **Workaround**: set ZENA_REPO_ROOT to a checkout containing the
  files (the flake wrapper keeps ZENA_COMPILER_WASM pointing at the
  installed compiler).

### RESOLVED: a forward-referenced generic class dropped its type arguments

- **Filed on** PR #236's branch as two entries — "A generic class field typed
  by a later-declared generic class miscompiles" (`identifier type shift`)
  and "`this as C<T>` into a generic class with a closure field crashes the
  compiler". They are one bug, and neither is about closures or `as`.
- **Fixed**: 2026-08-12. A forward reference materializes a SHELL for the
  declaration before the declaring pass runs, and the shell carried no type
  parameters. `resolveTypeAnnotation` skips instantiation when
  `typeParameters == null`, so it silently DROPPED the arguments the source
  wrote: `S<T>` came back as the raw `S`, whose codegen erasure is
  `S<anyref>` — a struct nothing constructs. `#materializeType` now fills a
  class's, interface's and mixin's own type parameters from the AST, the way
  the `TypeAliasDeclaration` arm beside it already did. Constraints stay
  unresolved there on purpose; the declaring pass fills them into the same
  location-keyed objects.
- **The reported crash was a landmine, not this bug.** `specialization.zena`
  carried a debug `throw` from 091c5172 (2026-07-20) firing for any class
  named `Node` or ending in `Node`, and the reduction's class was `Node`.
  Deleted. Renamed, that reduction failed with this bug instead.
- **Pinned by**: `tests/language/execution/generics/forward-referenced-generic-class.zena`.

### RESOLVED: a generic static's body could not reach any generic construct

- **Filed on** PR #236's branch. `Box.make<B>` bailed `class not discovered`
  when its body constructed a generic class, and `generic call` when it
  delegated to a generic free function instead.
- **Fixed**: 2026-08-12. RTA's `resolveType` substituted a function's OWN
  type arguments only when the node was a `FunctionExpression`. A generic
  METHOD is a `MethodDefinition`, so its body was walked with its parameters
  still open — `new State<B>` stayed `State<B>`, erased to `State<anyref>`,
  and the `State<i32>` the call needs was never discovered. Lowering then
  bailed on the specialization it had just been handed.
- **Not** fixed by #232/#237: verified against a compiler built from #237's
  head, which contains all of #232's commits.
- **Pinned by**: `tests/language/execution/generics/generic-static-body.zena`.

### RESOLVED: symbol-keyed members resolved by name, so an unexported symbol was not private

- **Filed on** PR #236's branch. `docs/design/classes.md` §9.4 promises that
  an unexported symbol puts a member out of reach, and `zena:ownership`
  relies on it for the resource lifecycle flag. Nothing enforced it.
- **Fixed**: 2026-08-12, in three parts, because the hole had three layers:
  - **The visitor never walked a member expression's `symbolPath`**, so
    `assignNodeIds` never reached those nodes and every symbol path in a
    module kept the default node id. Any node-keyed map collapsed them onto
    one entry: the reference map answered every `x.:sym` with whichever
    symbol was recorded last. This is a latent hazard beyond symbols — a
    subtree of the AST had no ids at all.
  - **Nothing resolved the symbol**, on either side. The scope builder now
    processes the access's `symbolPath` and a member declaration's
    `symbolRef`, so naming a member requires its symbol to be in scope.
  - **The member key is the mangled string `":" + name`**, which cannot tell
    two same-named symbols apart. `MemberInfo.symbolTypeId` records the
    declaring symbol's identity and the access compares it. It fails OPEN
    (-1) rather than guessing, since an inherited member copied into a
    subtype's table loses the record.
- Also made `SymbolType` canonical per declaration (location-keyed, like
  `typeParameterTypes`): a dependency module is checked more than once and
  symbol id spaces restart per parse, so an id-keyed cache minted a second
  identity for one declaration.
- **Still name-keyed**: the qualified `:Iface.sym` form. `static symbol`
  inside an interface mints no `SymbolType` at all, so there is no identity
  to compare; its privacy is the interface's — the qualifier must resolve,
  which is what `zena:ownership`'s unexported `OwnState` relies on.
- **Pinned by**: `tests/language/semantics/symbols/private-symbol/` (both
  forged-symbol and no-symbol-at-all) and
  `tests/language/execution/symbols/cross-module/` (the exported symbol must
  still work).

### RESOLVED: an unresolved name in a `case` pattern silently became a catch-all

- **Fixed**: 2026-08-06 by b5cc02fa, "Report unresolved names in patterns
  instead of binding them" — a bare identifier in a pattern is a
  _reference_, not a binding; binding is spelled `let x` / `var x`, which
  the parser already produces as a distinct node. The checker no longer
  invents a binding when the name fails to resolve to a class.
- **Verified**: a mistyped variant now reports at the mistake, with a
  suggestion, instead of silently swallowing the match:

  ```
  'Crcle' does not name a class, so it cannot be used as a pattern.
  Did you mean 'Circle'? Write 'let Crcle' to bind the matched value to
  a new variable.
  ```

  (A cascading `Unreachable case.` still follows on the arms after it,
  which is normal once the first arm has errored.)

- **Found**: 2026-08-06 (adding the narrow integer types; four new
  `case U8Type:` arms were added to a match in `compiler.zena` without
  adding the names to that file's import list).
- **Severity**: was high (silently disabled exhaustiveness checking, the
  main safety property of sealed hierarchies)
- **Details**: `case SomeName:` where `SomeName` resolves to nothing is
  parsed as an _identifier pattern_ — a binding that matches anything —
  rather than a class pattern. No unresolved-name diagnostic is emitted.
  The arm therefore consumes the whole scrutinee, and every later arm is
  reported as `Unreachable case.`, which points the reader at the wrong
  arms entirely: the errors began ten lines _below_ the actual mistake,
  and the arms named in them were all perfectly correct.
- **Why it is dangerous**: a _typo_ in a variant name has the same shape.
  `case ClasType:` in an otherwise-exhaustive match would silently turn
  into a catch-all, and exhaustiveness would stop protecting that match
  from then on — with no diagnostic anywhere.
- **Recurrences** (both 2026-08-06, same day it was filed — this is not a
  rare shape):
  - _Deleting_ a variant does it too, not just failing to import one.
    Removing `ByteArrayType` turned two surviving multi-line
    `case ByteArrayType: { … }` arms into catch-alls and produced nine
    `Unreachable case.` errors on innocent arms. Note the asymmetry that
    makes this easy to half-fix: a search-and-replace written for
    single-line arms (`case X: expr`) silently leaves the block form
    (`case X: { … }`) behind, and the block form is exactly the one that
    then swallows the match.
  - Because the diagnostics name _later_ arms, the instinct is to
    investigate the arms that are reported. Both times the actual
    mistake was the _first_ line that stopped erroring — i.e. the arm
    immediately above the first reported one. That is the place to look.
- **Why the fix is the right shape**: the original sketch here proposed
  guessing intent from capitalization. The fix that landed is better and
  needs no heuristic — binding already has its own syntax (`let x`) and
  its own AST node, so a bare identifier in pattern position is
  unambiguously a reference. The bug was the checker not holding a line
  the parser had already drawn. Worth remembering as an instance of the
  project's no-fuzzy-fallbacks rule: the fallback that invented a binding
  was exactly what made the failure silent.

### RESOLVED: a checkable member visit satisfied the later reachable one, stranding its closures (`Invalid ref_func: index < 0`)

- **Fixed 2026-08-06.** The guess in the original entry — an adaptation
  wrapper synthesized during lowering — was wrong; nothing is
  synthesized late. RTA visits a member twice, once while only
  _checking_ it and once as _reachable_, and `processQueues` gated both
  on a single `reachedMembers` set. So the checkable visit consumed the
  key and the reachable visit hit `continue` and never ran. That
  mattered because the closure branch of `traverseDependencies` calls
  `addFunction` unconditionally but `markFunctionReached` only when
  `currentReachable` — a closure created during the checkable visit is
  therefore _added but not reached_, and the reachable re-visit is what
  would have marked it. Skipped, it stayed unmarked, so RTA's
  `wasm.functions = reachedList` pruning dropped it and it never got an
  index in `layout()`, while lowering still emitted a `ref_func` to it.
  Fix: `reachedReachableMembers` alongside `reachedMembers`, mirroring
  the `reached`/`visited` split `queueReferrer` already keeps (and the
  `referencedInterfaceMembers` /
  `referencedReachableInterfaceMembers` pair beside it).
- **Why it looked cross-module-only**: nothing about it is. It needs
  the checkable visit of a member to land _before_ the reachable one,
  and the reachable queue drains first, so a small single-module
  program never orders them that way. Attempts to distill it into a
  portable test all passed pre-fix for that reason; the regression
  guard is `test:example` (below) instead.
- **Guard**: `npm run test:example -w @zena-lang/wit-parser` now
  compiles _and runs_ `examples/parse-wit.zena` with the self-hosted
  CLI. Verified failing before the fix and passing after.
- **Diagnosis aid kept**: the `ref_func` case in `emit.zena` used to
  fail inside `BinaryEmitter.emitRefFunc` with a message naming neither
  the target nor the enclosing function. It now throws with both, which
  is what turned this from "somewhere in codegen" into a named closure
  and its source location.

### RESOLVED: inherited-member snapshot froze pre-inference field types (the anyref getter)

- **Fixed 2026-08-05.** The `anyref` was a stale ErrorType snapshot,
  not a lookup default: an unannotated field (`var fixedLength = 0 - 1;`)
  holds an ErrorType placeholder in the base's member map until its
  initializer is inferred, and the inference patches the FieldInfo _in
  place_ — but extends-resolution used to _clone_ every inherited
  member into the subclass. A variant materialized on demand before the
  base's body check (here: the base's own earlier methods match over
  the variants, and `fixedLength` is declared after them) froze the
  placeholder forever, and RTA's synthesized variant getter lowered it
  to anyref over the physical i32 field. Fix: when the superclass has
  no type parameters to substitute, the subclass now _shares_ the
  parent's MemberInfo object, so the in-place inference fix-up is seen
  everywhere (the only in-place member mutation is that fix-up). Test:
  `execution/sealed-classes/inferred-field-copied-before-inference.zena`
  (both compilers).

### RESOLVED: record literals ignored their contextual type (one mint per initializer shape)

- **Fixed 2026-08-05** (surfaced by the wit-parser swap the moment the
  harness validated: 26 runtime `illegal cast` failures, all in
  multi-package tests). `serializeAstToJson` builds
  `{name: PackageName | null, items}` literals from both a nullable
  field and a non-null nested-package name; the checker synthesized the
  literal's type from its property initializers and never consulted the
  expected type, so the two literals got two different record mints —
  and record dispatch casts the receiver to the declared type's single
  mint. Fix: the RecordLiteral checker arm now does contextual typing
  like TupleLiteral always has — expected property types flow into the
  property values, and an assignable literal takes the expected record
  type as its node type. Test:
  `execution/records/record-literal-conforms-to-context.zena`
  (both compilers).

### RESOLVED: self/forward-referencing closure captures (the last wit-parser blocker)

- **Fixed 2026-08-05.** `let visit = (k) => { … visit(dep); … }` and
  forward references between sibling closures now lower through the
  existing celled-capture machinery: the capture analysis marks
  captured-before-init bindings as celled, statement lists pre-allocate
  an empty (null-holding) cell for celled `let f = (…) => …` bindings
  before any statement runs, and the declaration writes the closure
  value through the shared cell instead of allocating a fresh one.
  A follow-on in method registration: a METHOD registration no longer
  takes its signature from a same-named shadowing FIELD (a distributed
  variant's case param over the sealed base's accessor). With this,
  **every wit-parser module compiles with the self-hosted compiler**
  (12/12). Test: `execution/closures/recursive-local-closure.zena`
  (both shapes, both compilers).

### RESOLVED: distributed sealed variants and vtable-population reach (the other two wit-parser blockers)

- **Fixed 2026-08-05**, kept briefly as a map:
  1. **Distributed sealed variants** (`case X` in the sealed class +
     standalone `final class X(...) extends Base`): the standalone
     class now links into the sealed class's variant list at its
     `extends` check; `BindingPattern` (`case let X {…}`) participates
     in exhaustiveness subtraction (it previously fell through and
     never subtracted ANYWHERE — possibly related to the Z2022
     false-positive entry below, not yet confirmed); and a case param
     may shadow an inherited base METHOD (the polymorphic-accessor
     pattern `docs()` over a variant's `docs` field), matching the
     bootstrap. Test: `execution/match/sealed-distributed-variants.zena`.
  2. **Vtable-population reach**: `registerClassMethod` added functions
     to `wasm.functions` unconditionally but `markFunctionReached` was
     a no-op when the ambient phase flag said "checkable", leaving
     emitted bodies whose dependencies were never traversed — a
     graph-order-dependent miss (`String.split` lowering without its
     `FixedArray<String>` extension constructor, in wit-parser's graph
     but not others). Registration now force-reaches
     (`forceReachFunction`), making it deterministic.

### RESOLVED: no catch-and-recover try shape lowered (tail assignment, arm `return`)

- **Found**: 2026-08-05 (adding manifest loading to the self-hosted CLI's
  `main.zena`)
- **Fixed 2026-08-06.** Two independent bails between them ruled out
  every `try` that actually recovers: assigning an enclosing local from
  the body, and a body that `return`s.
- The assignment half was a semantics problem, not a missing feature. A
  protected edge leaves from anywhere in the region, so it can only
  carry values live at the region's ENTRY — never an assignment the
  body completed before it threw. ZIR grew mutable variables for it
  (`var_get`/`var_set`, one dedicated wasm local each); design and the
  `async`/`gen` exception are in ir.md §5.1.1.
- The `return` half was two checker bugs. `checkMatchCaseBody` typed a
  block ending in `return X` as X's type, when the value leaves the
  FUNCTION and the enclosing match/try gets nothing from that arm — it
  is `never`, like a `throw` tail. And arm types were combined with
  `createUnionType`, which drops `never` but kept `void`, minting
  `T | void`: no binding can hold it and it has no wasm representation,
  so it only deferred the failure to codegen. `combineArmTypes` lets
  `void` absorb, which is also what makes a statement-position
  try/match whose arms end in an assignment come out `void`.
- **Tests**: `execution/exceptions/try-tail-assignment.zena`
  (un-skipped), `try-body-assignment-visible.zena`,
  `try-arm-return.zena`, `execution/async/try-body-assignment-async.zena`,
  and `zir backend > try/catch keeps an assigned local off the heap`
  for the no-allocation invariant.

### Index writes through an interface are unsupported in ZIR

- **Found**: 2026-08-05 (writing a portable test for Sequence indexing
  through the trampoline)
- **Severity**: medium (loud bail, so no silent miscompile; blocks
  `MutableSequence`-typed writes)
- **Workaround**: operate on the concrete type (`FixedArray`, `Array`)
  instead of a `MutableSequence`-typed value when writing.
- **Details**: `parts[0] = v` where `parts: MutableSequence<T>` bails with
  `zir unsupported: interface index write`. Reads through `Sequence<T>`
  work (the `[]` trampoline inlines `array.get` as of 2026-08-05); the
  write-side call-site lowering was never implemented. The `[]=`
  trampoline body is already synthesized, so this is call-site work in
  `operators.zena`/`lowering.zena`.

### RESOLVED: Self-hosted compiler cannot build the language service

- **Found**: 2026-08-05 (attempting the language-service build swap for
  bootstrap retirement wave 1); **fixed 2026-08-05** — kept briefly as a
  map of the four distinct bugs the one symptom covered, since each has
  a portable test that pins it:
  1. **Checker: spliced default arguments vs the cycle re-check pass.**
     Omitted optional arguments are filled by splicing the callee's
     default-initializer AST into the caller's argument list — a
     mutation of the shared AST — while the guard record (the
     caller-written arg count) lived only in the per-pass
     SemanticModel. A file re-checked by the cycle-driven second pass
     starts a fresh model, so the re-check resolved the callee's
     initializer (`new IdGenerator<NodeId>()`) in the caller's scope:
     `Class 'IdGenerator' not found`. Masked everywhere in-compiler
     because every caller of `parse` imports IdGenerator. The record
     now also lives in SharedCheckerState (which exists to survive
     passes), re-seeds the fresh model for codegen, and the
     union-typed-callee arm gained the guard it never had.
     Test: `execution/imports/default_param_cycle.zena`.
  2. **RTA: map literals never registered their HashMap instantiation.**
     A `{k => v}` literal instantiates its checked HashMap class and
     calls its constructor and `[]=`, but carried no NewExpression, so
     a program whose ONLY HashMap construction is a literal (the
     tokenizer's KEYWORDS global, reached from an external entry) hit
     `zir unsupported: map constructor missing @__start`.
     Test: `execution/collections/map-literal-global-only.zena`.
  3. **RTA: tuple/array literals in method bodies missed struct
     discovery.** Method bodies with checker dependency records skip
     the full discoverNodeTypes walk; registerInstantiations never
     discovered array literals' element types nor boxed tuple literal
     structs, so an array-of-tuples local in a method materialized its
     struct during lowering — after layout ("Struct allocated after
     layout"). Test: `execution/records/tuple-array-in-method.zena`.
  4. **Codegen: host target emitted memory ops with no memory.**
     `ensureMemory()` only ran via WASI infra registration, so a host
     build reaching `zena:memory` (the compiler's time.zena, via the
     LSP) produced wasm that failed instantiation with `memory index 0
exceeds number of declared memories`. Reaching any linear-memory
     intrinsic now declares (and exports) the memory, matching the
     bootstrap. Covered by the language-service suite (54/54) against
     the self-hosted-built lsp.wasm.

### Self-hosted compiler: constructor not registered for a specialized OrderedMap

- **Found**: 2026-08-02 (first clean build after the compiler `outDir` fix)
- **Confirmed**: 2026-08-03 — still fails on `0d5a0efc`, which is upstream's
  own fix for the clean-checkout build, so this is independent of that work.
- **Severity**: high (`npm test` fails; blocks
  `packages/stdlib:build:wasi-tests:self-hosted`)
- **Workaround**: none known.
- **Details**: compiling `packages/stdlib/tests/string/string_test.zena` with
  the self-hosted compiler throws from
  `packages/zena-compiler/zena/lib/codegen/expr/classes.zena:117`:

  ```
  internal: constructor not registered for
  OrderedMap_s1029_String_s211_union_JsonObject_s1138_JsonArray_s1140_
  String_s211_Box_s677_f64_Box_s677_bool_null
  ```

  The type argument is the JSON value union, so this is the
  `OrderedMap<String, JsonValue>` specialization. `generateNewExpression`
  looks up a constructor for the monomorphized class and finds none, which
  suggests the specialization is reached during codegen without having been
  registered by the earlier pass that instantiates generic constructors.

  Not a regression from any recent commit's source: nothing in
  `dbad428e..0fa95166` touches either codegen tree, and
  `classes.zena` was last changed in `9bb52de7`. It was invisible until now
  because `@zena-lang/compiler` was resolving to stale build output — see
  below.

### `outDir` regression left the whole repo building against stale compiler output

- **Found**: 2026-08-02 — **already fixed**, recorded so the failure mode is known
- **Severity**: high while it lasted (silent: every package importing the
  compiler ran old code)
- **Details**: `294afa17` changed `packages/compiler/tsconfig.json` `outDir`
  from `"./"` (its value since the initial commit) to `"lib"`. With
  `rootDir: "./src"` and sources under `src/lib/`, output moved to
  `lib/lib/index.js`, while `package.json` still declares
  `main: "lib/index.js"` — the path that every sibling package and wireit's
  own `output: ["lib", "test", ...]` expect. Nothing failed at the time
  because `lib/index.js` still existed from an earlier build, so the six
  packages that import `@zena-lang/compiler` silently kept running it.
  Wireit's `clean: "if-file-deleted"` eventually wiped that artifact and the
  breakage surfaced as `TS2307: Cannot find module '@zena-lang/compiler'`.
  Fixed by restoring `"outDir": "./"`. Worth a guard: a check that
  `main` resolves after a clean build would have caught it immediately.

### Object-pattern destructuring rejects accessor properties

- **Found**: 2026-07-31 (writing portable coverage for tuple/object destructuring)
- **Severity**: low (explicit member reads work; the restriction is
  just surprising)
- **Workaround**: read the property explicitly (`let x = p.x;`).
- **Details**: Both checkers reject `let { x } = p` when `x` is an
  accessor rather than a physical field ("Type 'Point' has no
  property 'x'"), even though `p.x` reads fine through the getter.
  Destructuring should be property-based, not field-based — the
  member-lookup rules make no field/accessor distinction anywhere
  else. Repro:

  ```zena
  class Point {
    raw: i32;
    new(this.raw);
    x: i32 { get { return this.raw * 2; } }
  }
  let { x } = new Point(3); // error in both compilers; p.x works
  ```

  Codegen note: the ZIR object-pattern binder already reads through
  getters when given the chance (`#lowerObjectPropertyRead` falls
  back to the get# walk), so lifting the checker restriction should
  need no ZIR backend work.

### Unsigned widening casts sign-extend

- **Found**: 2026-07-27 (lowering `as` casts from unsigned in ZIR)
- **Severity**: medium (silent wrong values for u32 >= 2^31 / u64 >=
  2^63 in widening and float casts)
- **Workaround**: mask explicitly before widening.
- **Details**: Widening an unsigned value emits the _signed_ conversion
  — `(3000000000 as u32) as u64` sign-extends to a negative i64 —
  because the `_u` IrOps and emitter methods do not exist in ZIR.
  Verified still present 2026-08-06.
- **The justification for this is now void.** `scalarConvert` in
  `ir/operators.zena` still carries a comment explaining that the signed
  ops are deliberate, to stay byte-compatible with the streaming
  backend, "until that ruling". That backend and the bootstrap compiler
  are both deleted, so nothing is being matched any more; what remains
  is just a wrong answer. Fixing it means adding the four `_u`
  conversion ops and picking them from the operand's _semantic_ type
  (`scalarConvert` currently sees only wasm valtypes, so signedness has
  to be threaded in from the caller).
- **Not a narrow-integer problem**: `u8` and `u16` cannot reach 2^31, so
  they widen correctly regardless. `execution/literals/unsigned_literal_context.zena`
  deliberately stays within a single width to avoid resting on this path.

### Inline-tuple union miscompiles when both arms hole out a reference slot

- **Found**: 2026-07-28 (evaluating a `Result<V, E>` shape for zena:url)
- **Severity**: medium (invalid wasm from code both checkers accept; blocks
  the natural encoding of a two-payload Result)
- **Workaround**: keep holes in only one arm, or make at most one of the
  hole-opposed slots a reference type.
- **Details**: A union of inline tuples where _each_ arm holes out a slot that
  the other arm fills with a REFERENCE type produces a module that fails wasm
  validation. Both compilers accept the source and emit bad code (bootstrap:
  "expected (ref null $type), found i32"; self-hosted reports the same
  mismatch inverted).

  ```zena
  let f = (b: boolean): inline (true, String, _) | inline (false, _, String) => {
    if (b) { return (true, 'v', _); }
    return (false, _, 'e');
  };
  ```

  It is a narrow gap, not a general limitation — all of these DO work:
  - `inline (true, i32, _) | inline (false, _, i32)` (crossed holes, all i32)
  - `inline (true, i32, String) | inline (false, i32, _)` (holes in one arm)
  - `inline (true, String, _) | inline (false, _, i32)` (crossed, ONE ref)
  - `inline (true, String) | inline (false, _)` (the stdlib's Option shape)

  Only the two-reference crossed case fails, which is why the shipping
  `tests/language/execution/tuples/inline_tuples.zena` cases (holes opposite
  i32, or holes in a single arm) never caught it. Codegen looks correct at a
  glance — `codegen/expr/literals.zena` resolves a hole's default from
  `ctx.wasmFunction.signature.returns[i]` and only falls back to i32 when the
  index is out of range — so the fault is likely in slot-type resolution for
  this case (construction, or the destructure temp widening in
  `codegen/stmt/control-flow.zena`), and needs diagnosis rather than a guess.

  Why it matters: `inline (true, V, _) | inline (false, _, E)` is the shape a
  zero-allocation `Result<V, E>` wants — one slot each so V and E never have
  to share a representation. NOTE that fixing this is necessary but not
  sufficient for a _named_ Result: inline tuple types are also barred from
  type aliases ("Inline tuple types can only appear in function return types",
  pinned by tests/language/semantics/type-system/inline_tuple_restrictions.zena),
  so `type Result<V, E> = ...` needs a separate, deliberate language change.

  **Update 2026-08-05: FIXED in the self-hosted compiler, still broken in
  bootstrap.** Both the crossed one-ref case
  (`inline (true, i32, _) | inline (false, _, String)`) and the crossed
  two-ref case (`… String … | … String`) compile and run correctly
  self-hosted — pinned by
  `tests/language/execution/control-flow/if_let_result.zena` and
  `tests/language/execution/tuples/inline_union_crossed_ref_holes.zena`.
  The bootstrap compiler still emits an i32 for a hole in a reference lane
  ("type error in return[2] (expected (ref null …), got i32)"), so both
  tests carry `@skip: bootstrap`.

### Inline-tuple union with mismatched slot representations is accepted, then miscompiles

- **Found**: 2026-07-28 (same investigation)
- **Severity**: medium (silent acceptance of unrepresentable types; the
  failure surfaces only as invalid wasm at load time)
- **Workaround**: ensure every arm agrees on each slot's representation — use
  a hole plus a separate slot instead of two different payload types in one
  slot.
- **Details**: The checker does not verify that the arms of an inline-tuple
  union agree on each slot's wasm representation. A union whose slot 2 is a
  primitive in one arm and a reference in the other type-checks in both
  compilers and then emits a module that fails validation.
  ```zena
  let f = (b: boolean): inline (true, i32) | inline (false, String) => {
    if (b) { return (true, 42); }
    return (false, 'bad');
  };
  ```
  This should be a checker error at the declaration, in the same family as the
  existing "cannot mix inline tuple types with other representations"
  diagnostic — a slot that must hold both an i32 and a ref has no multi-value
  lowering, so it can never be valid. Catching it in the checker also turns
  the confusing wasm-validation failure into a message that points at the
  signature.

### Match arms over inline tuple unions do not narrow (self-hosted); bootstrap narrows

- **Found**: 2026-08-05 (adding a match test for the Result shape, PR #155)
- **Severity**: medium (blocks `match` as the two-arm consumer of
  `Result`-shaped inline unions; also a checker divergence between compilers)
- **Workaround**: consume both arms with two if-lets — pattern-based
  narrowing works there (`if (let (true, v, _) = f())` /
  `if (let (false, _, e) = f())`, pinned by
  `tests/language/execution/control-flow/if_let_result.zena`).
- **Details**: In the self-hosted checker, a match arm's tuple pattern over a
  union of inline tuples binds each element at the **merged lane type**
  instead of filtering union members by the literal tag: for
  `inline (true, i32, _) | inline (false, _, String)`,
  `case (false, _, e):` gives `e: _ | String` (and `case (true, v, _):`
  gives `v: i32 | _`), so using either binding is a type error. if-let
  narrows correctly via `narrowTypeByPattern`/`patternCanMatchType`; match
  arms (`checkMatchExpression`) never invoke that filtering. The bootstrap
  checker DOES narrow the arms (`e: String`) and then fails differently
  (no `.length` on `String` in check mode). Divergence pinned by
  `tests/language/semantics/control-flow/match/inline-union-arm-narrowing-unimplemented.zena`
  (`@skip: bootstrap`) — when self-hosted narrowing lands, that test starts
  failing and should be replaced with an execution test. Note codegen for a
  multi-value match scrutinee is untested beyond the checker — the checker
  rejection has masked whatever the ZIR lowering does. See
  docs/design/result-option.md.

### Bootstrap parser's generic-call lookahead scans across statement boundaries

- **Found**: 2026-07-28 (writing the zena:url parser)
- **Severity**: medium (rejects valid code; bootstrap-only, so it is also a
  compiler divergence)
- **Workaround**: avoid writing `>` immediately followed by `(` — hoist the
  operand into a local (`x > MAX` instead of `x > (255 as i64)`).
- **Details**: `#isGenericCall()` (parser.ts) scans forward from any `<` for a
  depth-balanced `>` and commits to parsing type arguments when the token
  after it is `(`. The scan explicitly ignores `;`, `{`, `}` and `)` ("just
  rely on depth"), so it happily pairs a `<` in one statement with a `>` in a
  later one. This rejects ordinary code:
  ```zena
  for (var i = 0; i < xs.length; i += 1) {
    if (xs[i] > (2)) { return 1; }
  }
  ```
  with "Expected '>' after type arguments. Got Dot". The self-hosted parser
  accepts and correctly compiles the same code, so the two disagree. The scan
  should stop at a statement boundary (`;`, `{`, `}`) before concluding a
  generic call.

### Bootstrap parser rejects a method call on a new-expression

- **Found**: 2026-07-28 (writing the zena:url tests)
- **Severity**: low-medium (rejects valid code; bootstrap-only divergence)
- **Workaround**: bind the instance to a local first.
- **Details**: `new Box().val()` fails to parse under the bootstrap with
  "Expected ')' after arguments. Got LParen", while `new Box().field` is
  fine and the self-hosted compiler accepts and correctly runs both (returns
  7 for the repro below).
  ```zena
  class Box { new() {} val(): i32 { return 7; } }
  export let main = (): i32 => new Box().val();
  ```
  Postfix call chaining is evidently not applied to a NewExpression the way
  member access is. Pin with a syntax test once fixed.

### RESOLVED (not a codegen bug): field-access benchmark 2x is a machine-code alignment artifact

- **Found**: 2026-08-05; **root-caused 2026-08-05** — kept here because the
  symptom will recur and looks alarming.
- **Severity**: none (measurement artifact on a ~0.2ns operation)
- **Details**: two of the four field-access benchmarks read ~4.2 ms per 10M
  iterations from self-hosted output vs ~2.1 ms from the bootstrap's, with the
  slow pair _changing membership_ after unrelated codegen changes. Root cause:
  both compilers fully devirtualize all four accesses to a bare `struct.get`
  loop (the self-hosted body is one instruction _shorter_ — Cranelift folds
  the load into the add), and the entire difference is code placement. On
  Zen 3, a tight dependent loop whose ~34-byte body fits inside one 64-byte
  fetch/op-cache block sustains 1 cycle/iteration; a body straddling a block
  boundary costs 2. Disassembling the exact cwasm caches behind the timings
  showed a 16/16 correlation between straddling and the slow numbers, in both
  compilers' artifacts and in both inlining configurations. Function starts
  are 16-byte-aligned cumulative sums of all preceding code, so any unrelated
  change re-rolls start%64 — which is precisely the observed slow-pair
  flip-flopping.
- **Do not "fix" this in Zena codegen** — it would only re-roll the dice.
  Cranelift has no loop-header-alignment option (the durable fix would be an
  upstream wasmtime/Cranelift feature request). When a sub-nanosecond-per-op
  benchmark delta quantizes to exactly ~2x, suspect alignment and verify by
  diffing loop addresses in `wasmtime objdump` output before investigating
  codegen.
- **Reproduce**: `npm run benchmark -w @zena-lang/zena-compiler -- --basic`,
  "Codegen Comparison: basic".

### Narrowing of a closure-captured `var` is not invalidated

- **Found**: 2026-08-13 (carved out of "narrowing survives an assignment",
  whose same-function half is fixed by the checker flow graph)
- **Severity**: medium (type-checks clean, can trap at runtime; needs a
  closure to reassign a captured narrowed `var`)
- **Details**: The flow graph is per function body, so two halves of the
  closure interaction escape it. A narrowing established in an enclosing
  function is kept when read inside a nested closure — the walk reaches the
  closure's own FlowStart and cannot see whether the enclosing function
  assigned between establishment and the closure running. And an
  assignment inside a closure to a captured `var` is invisible to the
  enclosing function's graph, so a narrowing there survives a
  `xs.forEach(() => { x = null; })` between guard and use. (Inside a loop
  body the pre-scan does catch closure assignments, deliberately.)
  TypeScript has the same holes. The capture pass
  (`analysis/capture.zena`) already computes `mutableCaptures`, which is
  the ingredient a conservative fix would use.

### `--dce` crashes codegen on `Regex.replaceAll`

- **Found**: 2026-07-30 (measuring regex engine size for the website)
- **Severity**: medium (a valid program fails to build with DCE on)
- **Workaround**: build without `--dce`.
- **Details**: `Compilation failed: Imported function -1 not found`,
  thrown from `CodeGenerator.generate`
  (packages/compiler/lib/codegen/index.js:499). The same source builds
  and runs without `--dce`. Reproduce:
  ```zena
  import {Regex} from 'zena:regex';
  export let main = (): i32 => {
    let re = new Regex('a');
    let s = re.replaceAll('abc', 'z');
    return if (re.test(s)) 1 else 0;
  };
  ```
  `test` alone is fine (~28 KB with `--dce`); adding `replaceAll` is
  what triggers it. The debug trace before the failure is full of
  `isMethodUsedInternal checking: Object_IterableUtils.contains / Not
found, returning false`, so the reachability pass is probably
  dropping a function that a `replaceAll` path still references, and
  the import index is left dangling.

### DCE is off by default and the size difference is ~340x

- **Found**: 2026-07-30 (same measurement)
- **Severity**: low (defaults question, not a defect)
- **Workaround**: pass `--dce`.
- **Details**: `export let main = (): i32 => 1;` builds to 12,636 bytes
  by default and 37 bytes with `--dce`. Any binary size quoted without
  the flag is misleading, and the 37-byte figure in README.md assumes
  it. Worth deciding whether `--dce` should be the default for
  `zena build`, or at least for release builds.

### Generic interface methods are not virtually dispatchable (diagnostic in place)

- **Found**: 2026-07-26 (probing primitive type-argument coverage)
- **Severity**: medium (was: high internal crash — both checkers now
  reject the call site with a proper diagnostic; the language-design
  question remains)
- **Workaround**: call generic methods on concrete receivers only —
  direct calls monomorphize per inferred type argument (map_spec_i32
  etc., covered by tests/language/execution/arrays/
  generic-method-primitive-mono.zena).
- **Details**: `Sequence<T>` declares `map<U>(...)`, but generic
  methods get no interface vtable slot (one slot cannot serve every
  U). Codegen used to crash internally on
  `(s: Sequence<i32>).map(f)`; both checkers now reject it ("Generic
  method 'map' cannot be called through interface 'Sequence'...",
  Z2008/NotCallable — pinned by tests/language/semantics/interfaces/
  generic-method-virtual-dispatch.zena). Still needs a ruling on the
  feature itself: implement erased virtual dispatch (box U through
  anyref via the class-vtable copies that already exist), or drop
  map from the Sequence interface so the declaration stops promising
  something uncallable.

### Exhaustiveness false-positive (Z2022) on large sealed matches

- **Found**: 2026-07-25 (adding dispatch arms in ir/lowering.zena)
- **Severity**: medium (rejects valid code; forced an is-chain workaround)
- **Workaround**: keep the match small (one added arm was fine) or use
  an if/is chain in the wildcard arm.
- **Details**: `#lowerExpressionDispatch` in
  zena/lib/codegen/ir/lowering.zena matches on the sealed Expression
  union (~30 cases) with 18 arms + `case _`. Adding seven more named
  arms (IsExpression, RangeExpression, PipelineExpression,
  SuperExpression, ArrayLiteral, RecordLiteral, MapLiteral) made the
  self-hosted checker report "Unreachable case. The match is already
  exhaustive." (Z2022) for every arm after the first added one and for
  the wildcard — with 25 of ~30 cases covered, i.e. clearly not
  exhaustive. Adding just IsExpression alone did not trigger it.
  Bootstrap behavior not compared. Reproduce by re-adding those arms.

### Integer literals in u32/u64 context: bootstrap accepts, self-hosted throws

- **Found**: 2026-07-25 (writing a u32 generic-specialization test)
- **Severity**: medium (u32/u64 literals unusable with the self-hosted
  compiler; compiler divergence)
- **Workaround**: `let x = 5 as u32;` — check the literal without an
  unsigned expected type, then cast.
- **Details**: `let half: u32 = 2000000000;` (or any integer literal in
  a u32/u64 expected-type position, including constructor arguments)
  type-checks under the bootstrap but makes the self-hosted checker
  throw "u32 anad u64 not supported yet" (checker.zena, NumberLiteral
  case — a TODO about negative literals turned into a hard throw).
  Large literals beyond i32 range (4000000000) are rejected by both.

### Prelude array builtins are user-visible in self-hosted only

- **Found**: 2026-07-25 (writing a ZIR execution test that called
  `__array_new_empty` directly)
- **Severity**: low (divergence; no stdlib impact)
- **Workaround**: tests and user code should reach the builtins via
  their stdlib wrappers (`newByteArray`, `copyBytes`, FixedArray
  methods).
- **Details**: The self-hosted checker registers `__array_len`,
  `__array_new_empty`, `__byte_array_copy`, etc. as prelude values
  visible to every module, so user code can call them. The bootstrap
  checker rejects the same calls with "Variable '**array_new_empty'
  not found" outside the stdlib. One of the two behaviors should win;
  hiding compiler-internal `**`-prefixed names from user modules
  (bootstrap behavior) seems like the right one.

### String-enum values are not usable as Strings

- **Found**: 2026-07-24 (while writing a ZIR enum test)
- **Severity**: low (string enums barely usable beyond same-enum
  comparison)
- **Workaround**: use plain String constants.
- **Details**: A string-enum member cannot flow anywhere a String is
  expected: `len(Word.Yo)` with `len(s: String)` is rejected by all
  three compilers, and `Word.Yo as String` type-checks under the
  bootstrap but MISCOMPILES (wasm validation error: local.set
  expected (ref str), found struct.get of type i32 — the enum value
  is compiled as its numeric discriminant). Either string-enum
  values should be assignable/castable to String consistently, or
  the cast should be rejected consistently.

### Index assignment typing is driven by the [] READ selection

- **Found**: 2026-07-23 (while adding []= overload selection)
- **Severity**: low-medium (limits []= overloads; compiler divergence)
- **Workaround**: give [] a read overload accepting every index type
  that []= accepts, and keep []= value types assignable to the []
  return type.
- **Details**: `recv[i] = v` type-checks the LEFT as an index READ:
  the value is checked against the [] return type (so a []= overload
  whose value parameter is not assignable-compatible with the read
  type is unreachable), and a PURE write whose index only matches a
  []= overload (not any [] read) is a type error under the bootstrap
  ("Type mismatch in index") while the self-hosted checker silently
  falls back to the primary [] signature — a divergence. Writes
  should be typed by []= selection (member-lookup.md §5.1): for
  non-compound index assignments, select the []= overload over
  (index, value) directly and use its value parameter as the
  assignment's expected/result type; compound assignments legitimately
  need both [] and []=.

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
  private-fields-generic\_<hash>.wasm) but not by the compiler binary
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

  Both compilers agree (bootstrap and self-hosted — they consume the
  same capture analysis), so this is a
  checker/semantic-model bug, not a codegen one: the celling predicate
  should be "captured AND mutated anywhere", not "mutated by the
  closure". Fixing it in the capture analysis fixes every backend at
  once; it is a user-visible semantics change (currently diverges from
  JS-style closure capture), so it deserves its own change with tests.
  Pinned (at the current shared behavior, with a comment) in
  tests/language/execution/closures/celled_captures.zena.

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

### Local class declaration doesn't shadow built-in `Symbol` type

- **Found**: 2026-02-14
- **Severity**: medium
- **Workaround**: Rename the class to avoid collision (e.g., `SymbolEntry` instead of `Symbol`)
- **Details**: When you declare `class Symbol` in a module, it should shadow the built-in `Symbol` type within that module's scope. Instead, references to `Symbol` still resolve to the built-in type, causing errors like "Property 'name' does not exist on type 'Symbol'". This affects any class name that collides with built-in types.

### Wasm compiler fails to emit `ref.cast` when reading a local that was narrowed by an `is` check

- **Found**: 2026-05-31
- **Severity**: high
- **Workaround**: Explicitly assign to a new local instead of overriding: `let classType = unnarrowedType as ClassType;`
- **Details**: When a variable is narrowed by `if (x is ClassType)`, the Zena type system treats it as narrowed logic-wise, but the underlying Wasm local remains its original generic uncasted type (e.g. `(ref null $Type)`). The bootstrap compiler does not inject dynamic `ref.cast` when later reading this variable to evaluate a property access. Wasm compilation fails with: `type mismatch: expected (ref null $ClassType), found (ref null $Type)`. Assigning it explicitly circumvents the flaw.

### Incremental carry-forward can serve models keyed by dead Symbols

- **Found**: 2026-08-04 (diagnosing the import-cycles CI failure)
- **Severity**: medium (acyclic incremental flows only; cyclic modules
  are exempt — re-check-closure members never carry forward)
- **Workaround**: none needed for batch compiles (no `previous`).
- **Details**: `LibraryLoader.invalidate(X)` clears `scopeResult` on
  X's direct importers, so their scopes rebuild with fresh Symbols,
  but `checkCompilation` carries their CheckResults forward when X's
  export signature is unchanged. The carried model resolves bindings
  by Symbol identity, so a later compilation that re-checks one of
  their dependents resolves imports through the current Symbols,
  misses in the stale model, and degrades the imports to error types.
  Fix shape: record the ScopeResult each result was checked against
  and treat a rebuilt scope as invalidating (must not regress the
  body-only-edit tests in incremental-checking_test), or mint stable
  SymbolIds per (path, declaration) so rebuilt scopes stay addressable.

### fs.zena errno messages lack the numeric code

- **Found**: 2026-07-26 (debugging a WASI errno 48 as "UNKNOWN")
- **Severity**: low
- **Workaround**: none.
- **Details**: \_\_errnoToString maps a subset of WASI errnos and prints
  bare "UNKNOWN" otherwise; unmapped codes (48 = ENOMEM among them)
  should at least print their number.

### Self-hosted checker mistypes forward-referenced classes with generic field initializers used from top-level functions

- **Found**: 2026-08-01 (writing zena:bench's analyze(): hoisting a
  method body into a top-level function made the whole module
  miscompile)
- **Severity**: medium (valid code crashes codegen with no diagnostic;
  bootstrap accepts the same code)
- **Workaround**: define classes before any top-level function that
  constructs them (method bodies are not affected — only top-level
  `let` function bodies).
- **Details**: A top-level function that constructs a class defined
  LATER in the same module, then calls a method through a field whose
  initializer is generic (`items = new Array<Inner>()`, `Inner` also
  defined later), makes the self-hosted compiler throw
  "Unsupported method call on type: <error>" from
  generateCallExpression — the checker assigned <error> silently, no
  diagnostic reaches the user. Minimal repro:

  ```zena
  import { Array } from 'zena:growable-array';
  let go = (): i32 => {
    let h = new Holder('a');
    h.items.push(new Inner('b'));  // <error> receiver here
    return h.items.length;
  };
  class Inner { vs: String; new(this.vs); }
  class Holder {
    name: String;
    items = new Array<Inner>();
    new(this.name);
  }
  export let main = (): i32 => go() - 1;
  ```

  Moving both classes above `go` compiles and runs correctly. A
  same-shape forward reference WITHOUT the generic field initializer
  (plain scalar fields) works, so the initializer's type resolution
  order is implicated. The bootstrap compiler accepts both orders.

### Closures inside generic class methods are not specialized by RTA

- **Found**: 2026-08-05 (writing zena:async's Future<V>)
- **Severity**: medium (loud: "non-concrete function reached:
  closure*impl*...")
- **Details**: A closure created inside a method of a generic class
  (e.g. `scheduleMicrotask(() => { cb(value); })` inside
  `Future<V>.complete`) registers one closure implementation for the
  template; RTA never produces per-instantiation specialized copies,
  so reaching it fails with "non-concrete function reached". Applies
  to the self-hosted compiler's RTA; the checker accepts the code.
- **A generic FUNCTION hits the same wall by another road**, with a
  different message: a closure created in one bails
  `zir unsupported: celled capture @twice_spec_i32`, not "non-concrete
  function reached". Same restriction, so fixing one without the other
  leaves half of "avoid closures in generic code" standing. Test:
  `execution/generics/closure-in-generic-function.zena` (`@skip`ped, so
  it self-retires).
- **Workaround**: avoid closures in generic code — use small generic
  classes implementing an interface (see zena:async's waiter objects).
  This is what keeps `Future.then`/`map`/`flatMap` unwritten.

### Generic templates: `this` and generic-typed fields check as the raw template type

- **Found**: 2026-08-05 (writing zena:async's completeWith)
- **Severity**: low, since 2026-08-12 — a required cast, not a blocker.
  Was medium while the cast did not lower.
- **Details**: Inside a generic class's methods, the self-hosted
  checker types `this` and reads of fields whose declared type
  mentions a type parameter (e.g. `owner: Future<A>`) as the RAW
  template type ("Future", no arguments). Passing them where the
  instantiated type is expected fails ("argument 'Future' is not
  assignable to parameter 'Future<V>'"). The bootstrap compiler
  substitutes correctly.
- **Workaround**: `this as C<T>` at the use site. This entry previously
  said casts only deferred the failure to a ZIR "identifier type shift"
  bail, so there was no clean workaround. That half was the
  forward-referenced-generic-class bug below, fixed by `86e63185`: the
  cast now lowers. `zena:async` uses it in `Future.onComplete`,
  `AllState.attach` and `RaceState.attach`, all three of which
  previously had to be restructured around it.
- **Remaining**: the cast should not be needed. It is also unchecked —
  nothing stops `this as C<Wrong>` in a template, where the checker has
  no argument to compare against.

### RESOLVED: a resource's `this` escapes through a closure capture

- **Found**: 2026-08-08 (reviewing what constrains `this` in a resource class)
- **Severity**: high (silent; defeats the handle regime entirely)
- **Details**: `this` inside a resource class's method is the bare class
  type. That is unspellable, so `return this` is rejected under every
  handle name — but a closure's type names nothing the spelling rule can
  reject, so capturing `this` launders it out:

  ```zena
  resource class Handle {
    escape(): () => i32 { return () => { this.bump(); return this.value(); }; }
  }
  let h = new Handle(1);   // Own<Handle>
  let f = h.escape();      // live alias, no handle
  let g = h.escape();      // and another
  ```

  Both closures mutate the resource, and neither is tracked. The design
  already names the fix: `this` should be `Borrow<R>`, whose second-class
  rules forbid closure capture.
- **Fixed** in two steps. First the second-class rules themselves, which
  were specified in ownership.md and implemented nowhere: a `Borrow<R>`
  may not be captured by a closure, stored in a field or a container, or
  returned without deriving from a borrow the function was handed
  (`semantics/ownership/borrow-does-not-escape.zena`,
  `borrow-is-not-stored.zena`). Then, 2026-08-10, `this` inside a
  resource's methods became a `Borrow<R>`, which points those rules at
  the receiver — `semantics/ownership/this-is-borrowed.zena`.
- **One part needed its own check**: `this` is captured as a receiver
  rather than as a captured symbol, so the symbol-keyed capture rule
  could not see it. `capturesThis` on a resource's method is rejected
  explicitly.

### RESOLVED: a resource class may extend an ordinary class, which leaks bare aliases

- **Fixed**: 2026-08-10. A resource class's supertype chain must be
  resources, and a non-resource may not extend a resource; both
  directions are now checked rather than falling out of the spelling
  rule, so `resource class Derived extends Handle` works and inherits
  `dispose`. `semantics/ownership/inheritance.zena` covers all three
  cases.
- **Found**: 2026-08-08
- **Severity**: high (silent)
- **Details**: `isResource` is read from the declaration and never
  inherited, and nothing checks the superclass. `resource class R extends
  Plain` is accepted, and any method `Plain` declares sees `this` as a
  bare, spellable `Plain`:

  ```zena
  class Plain { self(): Plain { return this; } }
  resource class OnPlain extends Plain { … }
  let r = new OnPlain();          // Own<OnPlain>
  let leaked: Plain = r.self();   // bare, freely aliasable
  ```

  `Own<>`'s nominal distinctness does not help: the leak happens inside
  the base method, where the type is spellable. The converse direction
  (`class Sub extends R`) and resource-extends-resource are both
  *accidentally* rejected — the extends clause is a type annotation, so
  naming a resource class there trips "has no unwrapped form" and then
  "Superclass must be a class type, got '<error>'". The advice to write
  `Own<R>` as a superclass is nonsense, and it wrongly blocks
  `resource class Derived extends Handle`.
- **Workaround**: do not give a resource class an ordinary superclass.
