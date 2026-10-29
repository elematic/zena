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

**The same block in many places.**

- _Check assignable, then instantiate, then adapt._ The sequence
  "if not `isAssignableTo` report a mismatch, else
  `tryInstantiateGenericFunction`, `setNodeType` when that changed
  something, `checkAndRegisterInterfaceAdaptation`" appears 21 times, and the
  adaptation call alone 36 times:
  variable and `using` declarations, `return`, `yield`, assignment,
  `??=`, pattern defaults, field initializers (class, mixin and
  decorated), case-class and variant defaults, parameter defaults
  (method and function), constructor and call arguments, super
  arguments, interface constructor bodies. One helper that takes the
  node, the source and target types and a message prefix replaces all
  of them.
- _Resolving a declaration's type parameters._ The loop "set
  `resourceMentionOk`, `resolveBound`, resolve the default,
  `getOrCreateTypeParameter`, `declareTypeName`, sometimes
  `registerTypeParameter`" is written out in
  `resolveFunctionFromAnnotations`, `#materializeType` (alias arm),
  `registerTypeAliasDeclaration`, `registerClassDeclaration`,
  `checkMethodSignature`, `checkInterfaceDeclaration` (twice),
  `checkMixinDeclaration`, `checkDeclareFunction` and
  `checkFunctionExpression`. Whether the loop calls
  `registerTypeParameter` differs between copies for no stated reason;
  one helper would settle that.
- _Default-argument splicing._ The `__LOCATION__` splice and the
  argument-count report are copied in `checkSuperInitArgs`,
  `checkConstructorArguments` and `checkCallExpressionInner`.
- _Rooting `:dispose`._ "Add the class symbol to `referencedSymbols`
  and `<symbol>.:dispose` to `referencedClassMethods`, set
  `needsExceptionInfra`" appears in `exitOwnScope`, `#addEdgeDrop`,
  `releaseDiscardedOwner`, `requireDisposable`, the owner-field store
  in the assignment arm, and `checkClassBodies`.
- _Overload candidates._ "The base method, then each of its
  `overloads`" is built in `resolveIndexType` (three arms),
  `equalityOverrideTarget`, the `==` operator, the `[]=` selection and
  `checkCallExpressionInner`.
- _The nullable receiver strip._ "Split a union into its null and
  non-null members" is written in `checkMemberExpression`,
  `checkIndexExpression`, `checkCallExpression`, and again as
  `unwrapNullableForMemberLookup`, `subtractNullFromType` and the
  `??=` nullability test.
- _Static versus instance access._ The pair of "Cannot access instance
  member on class" and "Cannot access static member on an instance"
  errors appears six times across `resolveMemberType` and the
  assignment arm; the setter-lookup block in the assignment arm is
  pasted twice in full.
- _Accessor bodies._ Getter and setter body checking is the same code
  in `checkClassMemberBody` and `checkMixinDeclaration`.
- _Index overload selection._ The `ClassType` and `InterfaceType` arms
  of `resolveIndexType` differ only in the receiver's type.
- _Walks over the flow graph._ `findLiveMove`, `findLivePathMove` and
  `#findFlowSuspend` are the same backward search with a different
  stopping condition; `#mustMoveWalk` and `#definitelyConsumed` are the
  same recursive must-analysis. `#walkBindingType` and `#walkPathType`
  are 350 lines of the same lowlink and memo machinery, duplicated
  because one keys by `i64` and the other by `String`.
- _Condition narrowing._ `extractIsNarrowing`,
  `extractNullGuardNarrowing`, `extractNullGuardPathNarrowing` and
  `extractIsPathNarrowing` are two rules (an `is` test, a null test)
  times two subjects (a binding, a member path).
  `getNarrowedTypesFromCondition` then calls all four for the true
  branch and all four again for the false branch, with the result
  inverted by hand.
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
  re-instantiate when anything changed.

**Dead and stale code.** `#resolveCheckerTypeName` has no callers.
`createUnionType` carries an empty loop under a "Wait, we don't have a
single NumberType" comment. `checkVariableDeclaration` has an empty
`if`. `validateFunctionDecorators` has an `if (false)`. Several
functions carry two doc comments, the first describing a neighbour
that has since moved (`wrapResourceInOwn`, `checkCyclicImportRules`,
`addImplicitInterface`, `typeOperatorTarget`, `registerCompilerIntrinsics`'s
section banners).

### Special cases that should be general

- `forInLowersToIndexLoop` names `FixedArray`, `ImmutableArray`,
  `Array` and `GrowableArray` by string, next to a `WellKnown` test
  for the ranges; the `Array` arm can only ever match a user class.
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

Sites in the checker that decide something from a name where an
identity exists:

- A declaration finding its own pre-materialized type by name:
  `registerClassDeclaration`, `classTypeOfDeclaration`,
  `checkInterfaceDeclaration`, `checkInterfaceConstructorBodies`,
  `checkMixinDeclaration`, `registerTypeAliasDeclaration`, and the
  sealed-variant lookups in `registerClassDeclaration`, all through
  `ctx.resolveTypeName(name)`. `checkEnumDeclaration` already does
  this right, through `ctx.declaredType(symbol)`.
- `resolveIdentifierInternal` turning a type declaration's symbol
  into a type by re-resolving its name.
- `finishModule` typing each export by `resolveTypeName(exportName)`.
- `Own`, `Borrow` and `Scoped` through `resolveTypeName` in
  `wrapResourceInOwn`, `wrapResourceInBorrow`, `borrowWrapFieldRead`
  and `typeOperatorTarget`; `receiverHandleIs` matching the written
  name `Own`/`Borrow`.
- `String` through `resolveTypeName` for `__LOCATION__` and template
  literals (the string-literal arm already uses the well-known type);
  `StringIndex` and the four range classes in the range arm;
  `extractContextualRangeBoundType` matching five range class names;
  `HashMap` in `mapLiteralType`.
- `literalPatternCanMatchType` accepting a string literal against any
  class named `String`.
- Type-argument inference keyed by parameter _name_
  (`HashMap<String, Type>` in `inferTypeArg`, `inferTypeParameter`,
  `instantiateGenericClass`, `instantiateGenericInterface`,
  `tryInstantiateGenericFunction`, `collectPatternInstantiations`), so
  two parameters called `T` in scope at once share one slot.
- Interfaces matched by name in `inferTypeArg`,
  `inferTypeArgsFromContext`, `findExtendedInterfaceTransitive` and
  `findImplementedInterfaceTransitiveInChecker`.
- `typesEqual` comparing type parameters, type aliases and mixins by
  name; `isAssignableTo` comparing two distinct aliases by name;
  `mergeHandleMembers` grouping handles by alias name.
- `isStaticReceiver` deciding an import names a type by scanning
  every dependency's exports for the imported name.
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

Still open:

- `extractIsPathNarrowing` and `isImmutableMemberPath` call
  `checkExpression` on the subject again, so a condition's member
  path is re-checked up to six times per `if` (true and false
  branches, each through the null-guard and `is` extractors), and the
  re-check records flow nodes and adaptations again.
- `getMatchedLiteralType` runs before every expression check, so a
  literal in a context typed by a literal union never reaches the
  numeric range rules.
- elematic/zena#80 (binding a `void` call) no longer reproduces: a
  `void` local binding is zero-width since issue #435.

### Performance

The compile-time budget is mostly codegen (see the baseline below), so
the checker's cleanups are judged by not regressing rather than by
what they save. What stood out:

- The condition re-checks above: a member-path condition costs six
  expression checks.
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

With that setting, on an idle machine, before and after the split:

| fixture            | phase          | before (ms) | after (ms) |
| ------------------ | -------------- | ----------- | ---------- |
| stdlib-moderate    | check          | 15.5        | 15.7       |
| portable-semantics | scope          | 135.6       | 137.5      |
| portable-semantics | check          | 246.8       | 256.2      |
| portable-semantics | check-register | 22.5        | 30.2       |
| portable-semantics | check-bodies   | 212.5       | 211.0      |
| portable-semantics | total          | 4110        | 4179       |

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
3. **The shared blocks.** The assignability-and-adaptation helper, the
   type-parameter helper, default splicing, `:dispose` rooting,
   overload candidates, the nullable strip, the static/instance check,
   accessor bodies, index selection.
4. **Name to identity.** The #288 sites above, each with a test where
   a user type borrows the name.
5. **Condition narrowing.** One subject type (binding or path), one
   pass per condition producing both branches' narrowings, no
   re-checking of the subject.
6. **The flow walks.** One backward search parameterized by its stop
   rule; one memoized walk keyed by a single key type.
7. **The body context record.** Replace the fifteen getter/setter
   pairs and the hand-written save/restore in `checkMethodBody`,
   `checkFunctionExpression` and `checkInterfaceConstructorBody`.
8. **Representation predicates.** One representation kind for casts,
   unions and `anyref`.
