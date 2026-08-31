# Known Bugs

This file tracks known bugs as a lightweight alternative to GitHub issues.
When you encounter a bug during development, add it here rather than
immediately trying to fix it (which can pollute the current task's context).
When a bug is fixed, delete its entry — git history is the archive.

## Format

````
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

### [Short description]

- **Found**: [Date]
- **Severity**: [low/medium/high/blocking]
- **Workaround**: [if any]
- **Details**: [description of the bug and how to reproduce]

````

## Active Bugs

### A cycle among the prelude's own modules breaks a large compile

- **Found**: 2026-08-16, trying to put the `dedent` tag in `zena:string`
  — which means `string.zena` importing `TemplateStringsArray`, whose
  module imports `zena:string` back.
- **Severity**: medium. Loud, and only reachable from a stdlib edit,
  since the cycle has to involve a prelude module. It is why `dedent`
  lives in `zena:template-strings-array` and not in `zena:string`.
- **Details**: adding one import line to `packages/stdlib/zena/string.zena`
  ```zena
  import {TemplateStringsArray} from 'zena:template-strings-array';
  ```
  is enough on its own — no other change, the name need not be used.
  Small programs still compile and run. Compiling the compiler does not:
  ```
  Error message: zir unsupported: class not discovered @ModuleGenerator.compile
  ```
  Which class is not reported. `docs/design/import-cycles.md` says cycles
  are legal, and this one breaks none of its rules (the names crossing it
  are classes), so either discovery or the two-pass re-check mishandles a
  cycle whose members are in the prelude closure — note that the closure
  is built without a prelude parent, so an edge into it moves a module
  between the two scope-building phases in `#resolveScopes`.

### `IterableUtils.all` fails to lower in some module graphs

- **Found**: 2026-08-14, adding `wit-parser` to the language service's
  module graph (via codegen). The same sources compile in the CLI graph.
- **Severity**: medium. It gates which packages may link which, which is
  an unreasonable coupling; the workaround shapes real architecture.
- **Details**: with wit-parser in the LSP graph, compiling
  `zena/lsp.zena --target host` bails:

  ```
  zir unsupported: closure argument type @Array_s884_Type_s9526.all
      [in Array_s884_Type_s9526.all]
  ```

  `Array<Type>.all` is `IterableUtils`' mixin method — nothing calls
  it; it is retained through the method table. Lowering its
  `predicate(item)` call fails `#conformToSlot` for that instantiation
  in that graph, while the same method for the same `T` lowers in the
  CLI graph (target `zena-cli`) after the 2026-08-14 bootstrap
  re-baseline. Graph- and target-dependent, which smells like the
  erased-versus-specialized closure-slot family.

- **Workaround**: codegen takes the WIT import encoder as an injected
  closure (`BinaryGenerator.importEncoder`) instead of importing
  `wit-parser`, which keeps the parser out of the LSP graph. Fixing the
  lowering would let codegen import it directly.

### A defaulted `this` parameter on an initialized field fails ZIR lowering

- **Found**: 2026-08-14, declaring a metadata class in the WIT encoder.
- **Severity**: low. Either half alone works, and the fix is dropping
  one of them.
- **Details**: a constructor `this` parameter with a default, on a field
  that also has an initializer, bails every _caller_ of the constructor:

  ```zena
  final class Meta {
    var count = 0;
    new(this.count = 0);
  }
  new Meta(3);   // zir unsupported: auto-box to any @main [in main]
  ```

  Remove the field initializer (`var count: i32;`) or the parameter
  default and it compiles and runs. The bail names the calling function,
  not the class, which makes the source of the failure hard to find —
  the reproduction above was bisected out of a five-hundred-line module.

- **Workaround**: don't initialize a field twice; the parameter default
  is the one that can express both spellings.

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
- **Was also**: _which_ of the two got the wrapper used to vary between
  compiles in one process. Exactly one spurious registration happens
  either way — `asciiUpperByte` gets no wrapper at all, despite
  identical usage — and hash order decided which function it landed on.
  Not a key collision: `FunctionValueWrapperKey` is
  `(symbolId, signatureKey)` with both fields in `==`, so the two never
  share a key. That half is fixed; see the `referencedTypes` note in the
  entry above.

### A type check the semantics tests expect and the checker does not make

- **Found**: 2026-08-08, tightening the semantics runner's `@error`
  matching. The directive had been passing against an unrelated error
  in the same file.
- **Severity**: medium — a real hole in the type system, and it was
  being reported as covered.
- **Missing**: `Box<Box<i32>>` is not rejected for a function returning
  a deduplicated generic union (`generics/union-dedup-generic.zena`).
- **Tracking**: the site carries a `// @missing-error:` directive,
  which asserts the error is still _absent_. Implementing it fails its
  test with a message saying to promote the directive to `@error:`, so
  the marker retires itself.

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

### Generic interface methods are not virtually dispatchable (diagnostic in place)

- **Found**: 2026-07-26 (probing primitive type-argument coverage)
- **Severity**: medium (was: high internal crash — both checkers now
  reject the call site with a proper diagnostic; the language-design
  question remains)
- **Workaround**: call generic methods on concrete receivers only —
  direct calls monomorphize per inferred type argument (map_spec_i32
  etc., covered by tests/language/execution/arrays/
  generic-method-primitive-mono.zena).
- **Details**: `Array<T>` declares `map<U>(...)`, but generic
  methods get no interface vtable slot (one slot cannot serve every
  U). Codegen used to crash internally on
  `(s: Array<i32>).map(f)`; both checkers now reject it ("Generic
  method 'map' cannot be called through interface 'Array'...",
  Z2008/NotCallable — pinned by tests/language/semantics/interfaces/
  generic-method-virtual-dispatch.zena). Still needs a ruling on the
  feature itself: implement erased virtual dispatch (box U through
  anyref via the class-vtable copies that already exist), or drop
  map from the Array interface so the declaration stops promising
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
  []= overload (not any [] read) is rejected rather than selecting
  that []= — the read finds no applicable overload and reports.
  Writes should be typed by []= selection (member-lookup.md §5.1): for
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

### No syntax for constant byte arrays / data segments

- **Found**: 2026-02-25
- **Severity**: low
- **Workaround**: Use `String.copyBytesTo()` to copy from a string literal, or call `__byte_array_set` for each byte
- **Details**: When you need a constant byte array (e.g., for the string "-2147483648" in number conversion), there's no clean way to express it. Options to consider:
  1. Byte array literals: `let bytes: ByteArray = [45, 57, 50, ...];`
  2. Compile-time string-to-bytes: `@bytes("-9223372036854775808")`
  3. Named data segments with `data` keyword

  Currently we work around this by using `String.copyBytesTo()` which works but allocates a String object unnecessarily.

### Wasm compiler fails to emit `ref.cast` when reading a local that was narrowed by an `is` check

- **Found**: 2026-05-31
- **Severity**: high
- **Workaround**: Explicitly assign to a new local instead of overriding: `let classType = unnarrowedType as ClassType;`
- **Details**: When a variable is narrowed by `if (x is ClassType)`, the Zena type system treats it as narrowed logic-wise, but the underlying Wasm local remains its original generic uncasted type (e.g. `(ref null $Type)`). The bootstrap compiler does not inject dynamic `ref.cast` when later reading this variable to evaluate a property access. Wasm compilation fails with: `type mismatch: expected (ref null $ClassType), found (ref null $Type)`. Assigning it explicitly circumvents the flaw.

### fs.zena errno messages lack the numeric code

- **Found**: 2026-07-26 (debugging a WASI errno 48 as "UNKNOWN")
- **Severity**: low
- **Workaround**: none.
- **Details**: \_\_errnoToString maps a subset of WASI errnos and prints
  bare "UNKNOWN" otherwise; unmapped codes (48 = ENOMEM among them)
  should at least print their number.

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
