# The checker's libraries

`lib/checker.zena` was one file of 26,080 lines. This document records
how it was split into `lib/checker/`, what reading the whole of it
turned up, and the cleanups that follow from that in the order they are
worth doing. The library map itself is in `lib/checker/CONTEXT.md`.

## The split

The split moved declarations without changing them. Each top-level
function, class, enum, alias and module-level `let` went to one of
twenty-one libraries by what it is about; `lib/checker.zena` re-exports
the nine names other packages import. The libraries import each other
freely and form one import cycle, the way `codegen/ir/` already does,
so the rules of `docs/design/import-cycles.md` apply: a function that
crosses a cycle's back edge needs every parameter and its return type
written out. Eighty-two functions had no return annotation and got
one; nothing else in a signature changed.

The gate for a change like this is the fixpoint check in `npm test`
(the compiler built by the split source must build itself to the same
bytes), plus `npm run bench:compile` against the baseline below.

## Findings

The sections below are what reading the whole checker in one sitting
shows. Each item names the function it is in. The order within a
section is roughly by how much it would simplify.

### Duplication

**The same block in many places.** The first eight below are now
one helper each; the rest are still open.

- _Check assignable, then instantiate, then adapt._ The sequence
  "`tryInstantiateGenericFunction`, `setNodeType` when that changed
  something, `checkAndRegisterInterfaceAdaptation`" appeared 21 times
  after an assignability check whose message differs per site:
  variable and `using` declarations, `return`, `yield`, assignment,
  `??=`, pattern defaults, field initializers (class, mixin and
  decorated), case-class and variant defaults, parameter defaults
  (method and function), constructor and call arguments, super
  arguments, interface constructor bodies. `adaptToExpected`
  (adaptation.zena) is the sequence; the message stays at the site.
- _Resolving a declaration's type parameters._ The loop "set
  `resourceMentionOk`, `resolveBound`, resolve the default,
  `getOrCreateTypeParameter`, `declareTypeName`, sometimes
  `registerTypeParameter`" was written out eleven times, and whether
  it resolved defaults or called `registerTypeParameter` differed
  between copies. `resolveTypeParameters` (annotations.zena) declares
  every parameter before resolving any bound, so a bound may name a
  later parameter, and resolves defaults everywhere.
  `registerTypeParameter` is gone: `getOrCreateTypeParameter` already
  did what it did.
- _Default-argument splicing._ The `__LOCATION__` splice was copied in
  `checkSuperInitArgs`, `checkConstructorArguments` and
  `checkCallExpressionInner`; `spliceDefaultArguments` (calls.zena).
- _Rooting a release._ "Add the class symbol to `referencedSymbols`
  and `<symbol>.:dispose` to `referencedClassMethods`, set
  `needsExceptionInfra`" appeared in `exitOwnScope`, `#addEdgeDrop`,
  `releaseDiscardedOwner`, `requireDisposable`, the owner-field store
  in the assignment arm and `checkClassBodies`;
  `CheckerContext.rootReleases`, over
  `CheckerContext.referenceClassMethod`, which the other
  "reference a method by `<symbol>.<name>`" sites use too.
- _Overload candidates._ "The base method, then each of its
  `overloads`" was built eight times; `overloadCandidates`
  (overloads.zena).
- _The nullable receiver strip._ "Split a union into its null and
  non-null members" was written in `checkMemberExpression`,
  `checkIndexExpression` and `checkCallExpression`; `stripNull`
  (unions.zena). `unwrapNullableForMemberLookup` and
  `subtractNullFromType` remain as the two no-flag forms.
- _Static versus instance access._ The pair of "Cannot access instance
  member on class" and "Cannot access static member on an instance"
  errors appeared six times across `resolveMemberType` and the
  assignment arm; `staticAccessMismatch` (members.zena).
- _Accessor bodies._ Getter and setter body checking was the same code
  in `checkClassMemberBody` and `checkMixinDeclaration`;
  `checkAccessorBodies` (classes.zena).
- _Index overload selection._ The `ClassType` and `InterfaceType` arms
  of `resolveIndexType` differed only in the receiver's type;
  `selectIndexRead` (members.zena).
- _Walks over the flow graph._ `findLiveMove`, `findLivePathMove` and
  `#findFlowSuspend` are the same backward search with a different
  stopping condition; `#mustMoveWalk` and `#definitelyConsumed` are the
  same recursive must-analysis. `#walkBindingType` and `#walkPathType`
  are 350 lines of the same lowlink and memo machinery, duplicated
  because one keys by `i64` and the other by `String`.
- _Condition narrowing._ `extractIsNarrowing`,
  `extractNullGuardNarrowing`, `extractNullGuardPathNarrowing` and
  `extractIsPathNarrowing` were two rules (an `is` test, a null test)
  times two subjects (a binding, a member path).
  `getNarrowedTypesFromCondition` then called all four for the true
  branch and all four again for the false branch, with the result
  inverted by hand. Now `narrowingSubject` names the subject once,
  and `conditionNarrowings` applies each rule once, producing both
  branches (`BranchNarrowings`); an `if` or loop calls it once for
  both of its edges.
- _Smaller repeats._ `isPrivate` as `name.sliceBytes(0, 1) == "#"` (22
  sites); `fd.mutability == "var"` (10); `fieldSetterNames` lookup
  (5); the getter/setter "Cannot override final method" block (twice);
  case-class parameter and sealed-variant parameter registration;
  `#materializeType`'s "symbolId = info.id unless `model.resolve`
  answers" (four arms); `invalidatePath`'s delete-by-prefix loop
  (three times); the location key `path#offset` in
  `getOrCreateTypeParameter` and `canonicalSymbolType`; the
  dependency-model scan in `lookupBindingTypeInDeps`,
  `resolveIdentifierInternal` and `#materializeFromSymbol`;
  `getNarrowedTypeFromPattern`'s and `subtractPatternFromType`'s
  `Identifier`/`IdentifierPattern` arms; the four arms of
  `substituteTypeParams` that substitute a type-argument list and
  re-instantiate when anything changed; the setter-lookup block in the
  assignment arm, pasted twice in full.

**Dead and stale code.** `#resolveCheckerTypeName` has no callers.
`createUnionType` carries an empty loop under a "Wait, we don't have a
single NumberType" comment. `checkVariableDeclaration` has an empty
`if`. `validateFunctionDecorators` has an `if (false)`. Several
functions carry two doc comments, the first describing a neighbour
that has since moved (`wrapResourceInOwn`, `checkCyclicImportRules`,
`addImplicitInterface`, `typeOperatorTarget`, `registerCompilerIntrinsics`'s
section banners).

### Special cases that should be general

- `forInLowersToIndexLoop` named `FixedArray`, `ImmutableArray`,
  `Array` and `GrowableArray` by string, next to a `WellKnown` test
  for the ranges, and reachability kept a second copy. The one copy
  is now in `types.zena`, by identity.
- `resolveMemberType`'s `ClassType` arm recognizes a mixin's `this`
  by the `_This` suffix of the class name and then scans every mixin
  and class declaration in the model by name. The class already
  carries `mixinSelf`, whose `symbolId` is the answer.
- `getIterationProtocol` and `getArrayPatternElementType` each walk
  the implements list and superclass chain for an `Iterable`; the
  `for`-in arm of `checkStatement` then walks it again by name
  (`findImplementedInterfaceTransitiveInChecker` with `"Iterable"`)
  to register the adaptation.
- `expectedArrayElementType`, `resolveArrayBackingClass`,
  `fixedArrayType`, the array-literal arm and
  `getArrayPatternElementType` each enumerate the array classes and
  interfaces their own way.
- `isValuePrimitive`, `isReferenceType`, `isAnyRefSource`,
  `isGuaranteedReference`, `isBoxablePrimitive`, `representationOf`
  and the inline "is this numeric" matches in `isValidCast` (six of
  them) are seven answers to "what representation does this type
  have". One function returning a representation kind would serve
  casts, unions and `anyref` alike.
- `isAssignableTo`'s class-to-interface case walks the class and then
  each superclass with the same loop body written twice; and it
  unwraps transparent aliases in two places with slightly different
  conditions.
- `typesEqual`'s `ClassType` and `InterfaceType` arms are the same
  code; `subtractNullFromType`, `subtractTypeFromUnion`,
  `subtractEnumFromType`, `subtractClassFromType` and
  `subtractInterfaceFromType` each rebuild a union minus some members.
- The `ThrowExpression` arm asks `isAssignableTo` against the
  well-known `Error` and then walks the superclass chain with
  `isWellKnown` as a second attempt.

### Name-based lookups (elematic/zena#288)

Sites in the checker that decided something from a name where an
identity exists. The first group is done; each site that could pick a
user's declaration has a portable test under `name-resolution/` in
which a program declares the borrowed name.

- A declaration finding its own pre-materialized type by name:
  `registerClassDeclaration`, `classTypeOfDeclaration`,
  `checkInterfaceDeclaration`, `checkInterfaceConstructorBodies`,
  `checkMixinDeclaration` and `registerTypeAliasDeclaration`, all
  through `ctx.resolveTypeName(name)`. They now ask
  `ctx.declaredTypeOf(node)`, which goes through the node's symbol and
  has no name fallback; `materializeDeclaration`, which had one, is
  gone. The sealed-variant lookups in `registerClassDeclaration` stay
  by name: a variant written `case Circle` next to a `class Circle` is
  a duplicate, and whether a name is declared twice is a question
  about the name.
- `resolveIdentifierInternal` turning a type declaration's symbol
  into a type by re-resolving its name. It materializes from the
  symbol it holds.
- `finishModule` typing each export by `resolveTypeName(exportName)`.
  A declaration exports its own symbol, so the export's type is what
  that symbol materialized to; only a re-export walks to its origin.
- `Own`, `Borrow` and `Scoped` through `resolveTypeName` in
  `wrapResourceInOwn`, `wrapResourceInBorrow`, `borrowWrapFieldRead`
  and `typeOperatorTarget`. All four use the well-known table, as
  `isOwnershipWrapper` already did to recognize a handle, so a
  program's own `Own` alias is neither wrapped in nor recognized.
  `receiverHandleIs` still matches the written name `Own`/`Borrow`.
  The table gains a row as the declaring file finishes checking, so a
  file of the declaring library asking earlier (`WithDefault` pointing
  at `Scoped` from inside `zena:core`) is answered from its scope,
  verified by identity, in `tryResolveWellKnownType`.
- `String` through `resolveTypeName` for `__LOCATION__` and template
  literals (the string-literal arm already used the well-known type);
  `StringIndex` and the four range classes in the range arm;
  `extractContextualRangeBoundType` matching five range class names;
  `HashMap` in `mapLiteralType`. `Range`, `ToRange`, `FullRange`,
  `StringIndex` and `HashMap` are now rows of the well-known table,
  and every one of these goes through it. A map literal in a
  compilation without `zena:collections` is reported rather than
  silently an error type.
- `literalPatternCanMatchType` accepting a string literal against any
  class named `String`. Now the well-known one.
- Reachability's `findPreludeClass` and `findPreludeInterface` took
  a name and answered with the first unit exporting a class or
  interface of that name, so a program exporting its own `Iterable`
  could stand in for the protocol. They take a `WellKnown` and check
  the identity.

- Type-argument inference keyed its map by the parameter's _name_
  (`HashMap<String, Type>` in `inferTypeArg`, `instantiateGenericClass`,
  `instantiateGenericInterface`, `tryInstantiateGenericFunction`,
  `collectPatternInstantiations` and the call checker). The map is
  keyed by the `TypeParameterType`, the object substitution already
  matches by identity.
- Interfaces matched by name in `inferTypeArg`,
  `inferTypeArgsFromContext`, `findExtendedInterfaceTransitive` and
  `findImplementedInterfaceTransitiveInChecker`, and in codegen's
  `findImplementedInterfaceTransitive` and
  `findExtendedInterfaceTransitive`, which lowering, reachability and
  template conversion fed the strings `"Iterator"`, `"Iterable"`,
  `"AsyncIterator"`, `"AsyncIterable"` and `"Stringable"`. The
  checker's take the interface type and match its declaration
  (`sameInterfaceDeclaration`); codegen's are
  `findImplementedWellKnownInterface`, `findImplementedInterfaceType`
  and `findExtendedWellKnownInterface`. A class implementing the
  standard library's `Iterable` and an interface that happened to be
  called `Iterator` was lowered as an iterator and failed; one
  implementing `Stringable` beside an interface of that name
  converted to `<Point>`.
- `typesEqual` comparing type parameters, type aliases and mixins by
  name, and `isAssignableTo` two distinct aliases by name, so two
  modules' `distinct type Meters = i32` were one type. Parameters are
  the same only as the same object, mixins by declaration and
  arguments, aliases by name and declaring module
  (`sameAliasDeclaration`). `mergeHandleMembers` still groups handles
  by alias name, which is sound: every member it groups has passed
  `isOwnershipWrapper`.

- `isStaticReceiver` deciding an import names a type by scanning
  every dependency's exports for the imported name, so an imported
  instance called `Config` was a static receiver whenever some other
  dependency exported a class called `Config`, and `Config.size` was
  "Cannot access instance member". It judges the declaration the import
  resolves to, and now answers for interfaces and mixins too, which
  `namesDeclaredType` used to add for local declarations only.
- `extractFutureValueType` goes through `isFutureClassType`, which is
  the right identity test; the comment explains why the well-known
  table cannot serve inside `zena:async` itself.

### Latent bugs

Fixed with the split, each with a portable test seen failing first:

- `flowTypeOfBinding` discarded a narrowing that is not assignable to
  the declared type, so `x is I` on a class-typed `x` narrowed nothing
  (elematic/zena#448). The narrowed `x` is an `I`; the class's own
  members are read before the test or after the branch.
- `inferTypeArg` bound a type parameter to a boolean literal's type, so
  `new Cell(true)` was a `Cell<true>` (elematic/zena#277). An argument
  now infers `boolean`; a written `Cell<true>` stays what was written.
- `checkMatchExpr` checked a guard's type and never applied its
  narrowings to the arm (elematic/zena#128).
- The argument pre-pass in `checkCallExpressionInner` typed a numeric
  literal against the first-declared overload's parameter, reporting
  range errors on the way, so `take(300)` over `take(u8)` and
  `take(i32)` was an error (elematic/zena#77). The pre-pass now types
  the literal on its own, which is what `docs/design/member-lookup.md`
  describes.
- The assignment arm checked an index target as a read, so an
  `operator []=` whose index no `operator []` accepted was unreachable
  (elematic/zena#121). `checkIndexWrite` selects the `[]=` over the
  index and the value.
- `resolveMemberType` recognized a mixin's `this` class by the `_This`
  suffix of its name and scanned every declaration in the model for
  the mixin. The class carries `mixinSelf`.
- Reachability rooted the constructor of a resource `new` through the
  callee's symbol, looked up by id in the constructing module's model
  alone, so a resource class imported from another module had no
  constructor at lowering ("constructor missing"). The lookup goes
  through `getBindingType`, which reaches the declaring module. The
  well-known `Own` made this visible: `wrapResourceInOwn` used to
  demand an imported `Own`, and a synthesized WIT module that had not
  imported it was handed the bare class and so never took the resource
  path. Constructing a resource no longer requires importing `Own`.
- `hasSameSignature` and `signaturesMayOverlap` compared two generic
  methods' parameter types directly, so `measure<T>(tag: T)` was the
  same signature as an inherited `measure<T>(tag: T)` only because
  both spelled `T`. `alignTypeParameters` renames one method's
  parameters into the other's, position by position, before either
  comparison; the override of a generic method, and the array classes'
  `fold<R>` against `Iterable`'s, depend on it.
- A mis-restated interface constructor (`new swapped<V, K>` on
  `Table<K, V>`) had its own parameters replaced by the interface's,
  so its body's `HashTable<K, V>` was then compared with a
  `Table<K, V>` over different objects and reported again at every
  return. Its
  result is the interface at the parameters its restatement declared,
  each standing where the interface's parameter of that name stands.
- `tryInstantiateGenericFunction` inferred a generic method's
  parameter only through a bare parameter, an array or a class, so
  `map<U>` on the array classes, whose `U` appears in a callback's
  return type and in a `FixedArray<U>` returned where `Array<U>` is
  expected, was never instantiated; the comparison passed because
  both sides spelled `U`, and a class spelling it `V` was rejected.
  Comparing parameters by identity exposed it. The instantiation
  infers through `inferTypeArg`, the walk a call's arguments use.
- Whether a field read was wrapped in `Borrow` depended on whether the
  file had imported `Borrow`, since `borrowWrapFieldRead` and
  `wrapResourceInBorrow` found the handle by name and did nothing when
  the name was absent. The `scoped T` tests had not imported it, so
  reading a `Slot<Own<R>>`'s field was the take the design describes
  (ownership.md §"Takes") only by that accident; with the handle found
  by identity, the read is a take because the field is declared in the
  class's `scoped T` (`fieldReadsAsTake`). `this` inside a resource
  class's methods is now a `Borrow<R>` in every file.

Still open:

- `extractIsPathNarrowing` and `isImmutableMemberPath` called
  `checkExpression` on the subject again, so a condition's member
  path was re-checked up to six times per `if` (true and false
  branches, each through the null-guard and `is` extractors), and the
  re-check recorded flow nodes and adaptations again. The subject's
  type is now read from the model, where the condition's own check
  put it, and the condition is walked once per `if`.
- `getMatchedLiteralType` runs before every expression check, so a
  literal in a context typed by a literal union never reaches the
  numeric range rules.
- elematic/zena#80 (binding a `void` call) no longer reproduces: a
  `void` local binding is zero-width since issue #435.

### Performance

The compile-time budget is mostly codegen (see the baseline below), so
the checker's cleanups are judged by not regressing rather than by
what they save. What stood out:

- The condition re-checks above: a member-path condition cost six
  expression checks; it costs none now.
- `collectAssignedSymbolIds` walks a loop's whole body for every loop,
  so nested loops cost depth times size.
- `classifyOwnUses` walks a block's subtree at every block exit that
  has a drop candidate; `mentionsParamDerived` walks an initializer
  per scoped `let`.
- `checkFieldInitializer` compares every member key against every
  earlier field to decide what to hide, which is quadratic in the
  field count.
- `resolveMemberType`'s `_This` scan is linear in the number of mixin
  declarations per member access on a mixin's `this`.
- `isAssignableTo` substitutes the implements list of every class on
  the chain on every class-to-interface query and memoizes nothing.
- `lookupBindingTypeInDeps` is a linear scan over every dependency
  model, measured at 0.2 ms per compile in the benchmark, so it is
  fine as it is.

None of the walks is exponential: `#walkBindingType` is bounded by its
memo and step budget, and `findLiveMove` keeps a visited set.

### Idiom

- `CheckerContext` keeps fifteen fields as a private field plus a
  getter and a setter each (`returnType`, `yieldType`, `tryDepth`,
  `usingDepth`, `inConstructor`, `asyncValueType`, `asyncFutureType`,
  `suspensionRelaxed`, `cancelBlockFloor`, `inFinalizer`,
  `castLiteralTarget`, `owningReceiver`, `receiverSymbol`,
  `inDispose`, `bodyThisType`), and every body checker saves and
  restores them by hand. A record of the per-body context, swapped as
  `FlowBodyState` already is, would replace all of it.
- `while (i < xs.length) { ...; i += 1; }` where `for (let x in xs)`
  would do: 58 loops.
- `match (x) { case T as t: {...} case _: {} }` with one arm: 107
  `case _: {}` arms, most of them in one-arm matches.
- `ownershipHandleName(t) == "Own"` and its siblings: 16 string
  comparisons on an answer that could be an enum.
- Casts after an `is` test the checker already narrows (`(t as
ClassType)` under `if (t is ClassType)`), and `as Type` upcasts in
  `if`/`else` arms.
- Pure type predicates that belong in `types.zena` next to the ones
  already there: `isAffineValue`, `isAffineTuple`,
  `isScopedValueType`, `isWithDefaultType`, `isNullableType`.

## Baseline

`npm run bench:compile` measures the compiler's phases on fixed
fixtures. Its numbers move with the GC: wasmtime's collector runs when
the heap reaches a threshold, and where a collection lands depends on
allocation history, so a layout change can move 700 ms between the
`scope` and `check` phases without changing the work done. Run it with
`ZENA_GC_RESERVE_MB=512`, which pre-grows the heap, to compare the
phases; the run-to-run spread is then under 1%.

With that setting, on an idle machine, before and after the split, and
after each later step (on a loaded machine; the narrowing column ran at
a load average of 11, which is where its `check-register`, untouched by
that step, picked up 7 ms):

| fixture            | phase          | before (ms) | split (ms) | identity (ms) | inference (ms) | narrowing (ms) |
| ------------------ | -------------- | ----------- | ---------- | ------------- | -------------- | -------------- |
| stdlib-moderate    | check          | 15.5        | 15.7       | 15.1          | 15.5           | 23.6           |
| portable-semantics | scope          | 135.6       | 137.5      | 127.0         | 130.7          | 146.6          |
| portable-semantics | check          | 246.8       | 256.2      | 248.0         | 244.7          | 254.2          |
| portable-semantics | check-register | 22.5        | 30.2       | 30.6          | 30.6           | 37.2           |
| portable-semantics | check-bodies   | 212.5       | 211.0      | 202.9         | 199.1          | 197.9          |
| portable-semantics | total          | 4110        | 4179       | 4104          | 4211           | 4801           |

`portable-semantics` compiles `zena/test/portable_semantics.zena`,
which imports the compiler, so it is the one fixture whose input the
split changed. The 8 ms it gained is in registration: the members of
an import cycle register their signatures twice
(`docs/design/import-cycles.md`), and the checker's libraries are now
such a cycle. Nothing else moved. A later cleanup is a regression when
`check-bodies` on this fixture moves by more than the spread.

## Order of work

Each step is one PR, lands green on `npm test`, and keeps
`bench:compile` within the spread.

1. **The split.** This document, `checker/CONTEXT.md`, the moved
   declarations, the added return annotations.
2. **Quick fixes with tests.** #448, #277, #128, #77, #121 and the
   `_This` scan, each with a portable test seen failing first.
3. **The shared blocks.** The nine helpers listed under duplication:
   assignability-and-adaptation, type parameters, default splicing,
   release rooting, overload candidates, the nullable strip, the
   static/instance check, accessor bodies, index selection.
4. **Name to identity.** The #288 sites above, each with a test where
   a user type borrows the name. Done, in two PRs: the well-known and
   own-declaration sites, then inference, interface matching,
   `typesEqual` and `isStaticReceiver`.
5. **Condition narrowing.** One subject type (binding or path), one
   pass per condition producing both branches' narrowings, no
   re-checking of the subject. Done.
6. **The flow walks.** One backward search parameterized by its stop
   rule; one memoized walk keyed by a single key type.
7. **The body context record.** Replace the fifteen getter/setter
   pairs and the hand-written save/restore in `checkMethodBody`,
   `checkFunctionExpression` and `checkInterfaceConstructorBody`.
8. **Representation predicates.** One representation kind for casts,
   unions and `anyref`.
