# Known Bugs

This file tracks known bugs as a lightweight alternative to GitHub issues.
When you encounter a bug during development, add it here rather than
immediately trying to fix it (which can pollute the current task's context).

## Format

```
### if-let accepts any refutable pattern but only inline tuples are implemented
- **Found**: 2026-07-31 (review question on #95: "if-let should work
  with any refutable pattern — do we need more coverage?")
- **Severity**: medium (checker-accepted syntax crashes codegen)
- **Deferred**: per review (2026-07-31) — implement once the bootstrap
  compiler is retired; one implementation instead of two.
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
- **Deferred**: per review (2026-07-31) — fix once the bootstrap
  compiler is retired; one implementation to change instead of two.
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

### Unsigned widening casts: bootstrap uses \_u opcodes, self-hosted signs-extends

- **Found**: 2026-07-27 (lowering `as` casts from unsigned in ZIR)
- **Severity**: medium (silent wrong values for u32 >= 2^31 / u64 >=
  2^63 in widening/float casts, self-hosted only)
- **Workaround**: mask explicitly before widening.
- **Details**: The bootstrap's AsExpression codegen picks
  i64.extend_i32_u / f64.convert_i{32,64}_u for unsigned sources; the
  self-hosted compiler has no unsigned conversion path at all and
  emits the signed variants (e.g. `(3000000000 as u32) as u64`
  sign-extends) — the `_u` IrOps and emitter methods do not exist in
  ZIR. Verified still present 2026-08-05.

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

### Narrowing survives an assignment that invalidates it (unsound)

- **Found**: 2026-08-04 (evaluating whether a checker flow graph would
  improve narrowing, for ownership.md layer 2)
- **Severity**: high (type-checks clean, traps at runtime)
- **Workaround**: don't reassign a narrowed variable inside the narrowed
  branch. There is no diagnostic, so this is not discoverable.
- **Details**: Narrowing is stored in a lexically-scoped stack of
  `narrowedTypes` maps (checker/context.ts) that is pushed and popped per
  scope. Nothing removes a narrowing when the narrowed path is assigned, so
  a narrowing outlives the fact that established it:
  ```zena
  class Box { var v: i32 = 42; }
  let f = (b: Box | null): i32 => {
    var x = b;
    if (x !== null) {
      x = null;
      return x.v;   // accepted; x is null
    }
    return 0;
  };
  ```
  `zena check` reports nothing; running it fails with
  `RuntimeError: dereferencing a null pointer`. The unnarrowed control
  (`b.v` with no guard) correctly reports Z2001, so the null check itself
  works — it is invalidation that is missing.

  The fix wants an assignment-aware flow graph rather than a scope stack:
  see [ownership.md](docs/design/ownership.md) "A flow graph, not a new IR".
  A targeted patch (clear narrowings for a path on assignment to it) would
  close this specific hole sooner, and is worth doing independently since
  the flow graph is a larger piece of work.

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

