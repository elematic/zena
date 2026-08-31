# Builtin type operators

A type operator is a generic type alias whose application runs a rule
built into the compiler instead of unwrapping to the alias's body:

```zena
@intrinsic('type.awaited')
declare type Awaited<T>;
```

The declaration is ordinary surface syntax — a decorated, bodyless
alias — so the name has an import trail, documentation, and a home in
the module that owns its subject. It is bodyless on purpose: the whole
reason for an intrinsic is that the type cannot be expressed in Zena's
type system, so any body would lie about what the type is. (The
decorator only parses before `declare`, which is what keeps ordinary
aliases undecoratable.) Zena has no user-defined conditional types,
deliberately: each operator is one blessed rule with fixed semantics,
and the family grows one at a time. If it ever grows past a handful
with visibly shared structure, that is the moment to design a general
form; two is not that moment.

## Application and normalization

Applying an intrinsic alias to a **closed** argument — one that
mentions no type parameters — normalizes immediately: `Awaited<
Future<i32>>` never exists as a type; the annotation resolves straight
to `i32`. An **open** argument leaves a symbolic alias instance
(`Awaited<T>`), and every substitution re-applies the rule, so the
first substitution that closes the argument normalizes the alias away.
Codegen never sees a closed operator, and an open one erases the way
its argument does — the instance's placeholder target is the argument
itself, so erasure, value-typing, and specialization keys treat
`Awaited<T>` exactly as `T` while it is open, which is the only sound
answer available before the argument is known.

Internally the declared operator's placeholder target is its own
first type parameter — never anything a user wrote. Alias unwrapping
treats intrinsic aliases like distinct ones: it stops rather than
flowing to the placeholder target. The rule application
lives in `applyTypeIntrinsic` (types.zena), and every place that
substitutes into a `TypeAliasType` — the checker's substitution, the
type module's, and codegen's — re-applies it after substituting the
arguments. A new substitution site owes the same call; the
distinct-alias work's "missing `TypeAliasType` case in sibling
matches" failure mode applies here unchanged.

## `type.awaited`

`Awaited<T>` is the type `await x` has when `x: T` (async.md §1), as a
total function: `Future<U>` becomes `U`, a union maps its arms —
future arms unwrap, bare arms pass through, duplicates collapse — and
anything else passes through unchanged.

**One level, deliberately.** TS's `Awaited` is recursive because JS's
runtime collapses nested thenables — a settled `Promise<Promise<T>>`
cannot exist there, and the recursive type models that. Zena's runtime
does not collapse: `Future<Future<T>>` is a real value and one `await`
unwraps one layer, so a recursive operator would describe behavior the
language does not have. One level is also what monadic bind means, and
it is what a flattening `then` needs — the callback's future forwards
one layer.

The rule identifies `Future` by name and declaring module
(`isFutureClassType`) rather than by prelude identity, so it can run
in substitution contexts that have no checker in reach.

## Planned operators

- **`WithDefault<T>`** — `T` for a primitive, `T | null` for a
  reference: the honest type of a default-initialized field of an
  unbounded `T`, surfacing the `weakenToNullable` operation frames
  already apply. De-boxes `Future`'s value slot and gives collections
  an honest empty-slot element type. Needs its companion
  `defaultValue<T>(): WithDefault<T>` intrinsic and the field
  defaultability rule; see the async roadmap in PLAN.md.
