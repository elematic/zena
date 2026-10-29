# The type checker (`lib/checker/`)

The checker walks a module's AST, infers types, validates them, and
writes what it learned into the module's `SemanticModel`. The AST is
never mutated except for one case: a call or `new` whose arguments are
fewer than the callee's parameters gets the callee's default
initializers spliced into its argument list (`splicedArgCountOf`
records how many the caller wrote).

`lib/checker.zena` is the public surface: `checkModule`, `beginModule`,
`finishModule`, `ModuleCheck`, `CheckResult`, `SharedCheckerState`,
`typesEqual`, `isNullableType`, `unwrapAliases`. Everything else lives
here. The libraries import each other freely and form one import cycle,
like `codegen/ir/`; the rules for what may cross a cycle are in
`docs/design/import-cycles.md`. In practice: every function one of
these libraries exports needs its parameter and return types written
out, and a module-level `let` is read only by the library that declares
it.

## Checking a module

Checking has two halves (`module.zena`). `beginModule` registers every
declaration's signature: imports, classes, interfaces, enums, mixins,
type aliases, `declare function`s and symbols. After it, every type
identity and member signature in the module exists, so a method body
can call a method of a class declared further down. `finishModule`
checks the bodies, then binds the module's exports. A module outside
any import cycle runs the two back to back; the members of a cycle all
begin before any finishes. A dependency module leaves its function and
member bodies for reachability to ask for (`DeferredModule`,
`docs/design/lazy-body-checking.md`).

Name resolution for values delegates to the scope pass's `ReferenceMap`:
an identifier resolves to a `Symbol`, and the symbol's binding type is
stored in and read back from the `SemanticModel`. Type declarations are
materialized on demand, by symbol identity, the first time anything
names them (`CheckerContext.#materializeFromSymbol`); a declaration has
exactly one type object however many modules or passes ask for it
(`SharedCheckerState.declaredNominalTypes`).

## Library map

| Library             | Holds                                                                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context.zena`      | `SharedCheckerState` (what one compilation shares across modules) and `CheckerContext` (one module's check): type materialization, binding and reference resolution, the per-body context (return, yield and async types), the flow graph and its narrowing and move walks, the implicit-drop verdicts, diagnostics. |
| `module.zena`       | `checkModule`, `beginModule`, `finishModule`; `DeferredModule`; the compiler intrinsics the prelude does not declare; the import-cycle rules for one imported name.                                                                                                                                                  |
| `annotations.zena`  | `resolveTypeAnnotation`: a type annotation node to a `Type`, with the inline-tuple, row-parameter and resource-mention rules.                                                                                                                                                                                        |
| `unions.zena`       | `createUnionType` and the union rules (representation mixing, handle merging, class members folding into interface members, discriminated tuples); `unwrapAliases`, `subtractNullFromType`.                                                                                                                          |
| `relations.zena`    | `isAssignableTo`, `typesEqual`, `isValidCast` and the other cast rules (opaque types, type-parameter minting), the representation predicates (`isValuePrimitive`, `isReferenceType`, ...).                                                                                                                           |
| `generics.zena`     | `substituteTypeParams`, type-argument inference (`inferTypeArg`), constraint checking (`applyAndCheckTypeArguments`), `instantiateGenericClass` and `instantiateGenericInterface`.                                                                                                                                   |
| `adaptation.zena`   | `checkAndRegisterInterfaceAdaptation`: where a value crosses a representation boundary (class to interface, function re-wrapping, record repacking), recorded for codegen.                                                                                                                                           |
| `ownership.zena`    | The ownership rules (`docs/design/ownership.md`): second-class storage, affine values, moves (`recordArgumentMove`), owner-field moves, the implicit-drop candidates, `requireDisposable`.                                                                                                                           |
| `protocols.zena`    | The iteration and future protocols: `getIterationProtocol` for `for`-in, `Iterator<T>`, `AsyncIterator<T>` and `Future<T>` construction and inspection.                                                                                                                                                              |
| `narrowing.zena`    | What a condition narrows (`getNarrowedTypesFromCondition`), member-path keys, and the definitely-exits analysis.                                                                                                                                                                                                     |
| `literals.zena`     | Numeric literal typing against context (`checkIntegerLiteral`), and whether a literal argument adapts to a parameter.                                                                                                                                                                                                |
| `overloads.zena`    | Overload applicability and most-specific selection, for calls and operators.                                                                                                                                                                                                                                         |
| `expressions.zena`  | `checkExpression`: literals, identifiers, assignment, `if`, casts, `is`, array, record, tuple and map literals, templates, `throw`, `try`, ranges, pipelines; `checkBinaryExpression`; `checkAwaitExpression`.                                                                                                       |
| `members.zena`      | Member keys (name-keyed and symbol-keyed), `checkMemberExpression`, `resolveMemberType`, index expressions, static symbols.                                                                                                                                                                                          |
| `calls.zena`        | `checkCallExpression` and `checkNewExpression`: argument checking, default splicing, generic calls.                                                                                                                                                                                                                  |
| `functions.zena`    | `checkFunctionExpression`: arrows and `function` bodies, contextual parameter typing, generators and async bodies, captures.                                                                                                                                                                                         |
| `statements.zena`   | `checkStatement`: declarations, `return`, `yield`, loops, `if`, imports and re-exports, `using`, tail returns.                                                                                                                                                                                                       |
| `patterns.zena`     | `bindPattern` (irrefutable) and `checkPattern` (refutable): record, tuple, array and class patterns, and the type a bare class name in a pattern stands for.                                                                                                                                                         |
| `match.zena`        | `checkMatchExpr` and exhaustiveness: what each arm's pattern subtracts from the scrutinee's type.                                                                                                                                                                                                                    |
| `classes.zena`      | `registerClassDeclaration` (signatures, inheritance, case classes, mixin application, field decorators) and `checkClassBodies` (initializers, member bodies, interface conformance, the resource rules); `checkMethodSignature`, `checkMethodBody`, `checkSuperInitArgs`.                                            |
| `declarations.zena` | Interfaces and their constructors, type aliases and type operators, enums, mixins and decorators, `declare function`, `symbol`.                                                                                                                                                                                      |

## The flow graph

`CheckerContext` builds a control-flow graph (`analysis/flow.zena`) as
it walks a body: assignments, moves, narrowings, suspensions and joins
advance `currentFlow`. A reference's type is its declared type refined
by a backward walk from the reference to the body's entry
(`flowTypeOfBinding`, `flowTypeOfPath`), and use-after-move checking
walks the same nodes (`findLiveMove`). The walks memoize per join and
invalidate the entries a loop's back edge can change; see the comments
on `#walkBindingType`.

## Well-known types

The checker never decides what a standard library type is from its
name. `ctx.tryResolveWellKnownType(WellKnown.X)` answers with the
declaration the library owns (`well-known.zena`), and `isWellKnown`
compares a type's name and declaring library. The remaining name-based
sites are listed in elematic/zena#288.
