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

## `type.scopedFrom`

`ScopedFrom<T, R>` is `Scoped<R>` when `T` carries a second-class type
(a `Scoped` value, a restricted `Borrow`, or a `scoped` type parameter)
and `R` otherwise. It exists for one shape: a generic whose result must
be scoped exactly when an input is — `Future.allSettled<scoped T>`
returns `ScopedFrom<T, Future<Array<Result<Awaited<T>, Error>>>>`, so
a call over scoped futures yields a scoped result the caller must
consume, and a call over ordinary futures yields the ordinary future
existing callers expect (ownership.md §"Combinator audit").

Two things differ from `type.awaited`. While `T` is open the instance
stays symbolic, and `isScopedType`/`scopedInner` answer for it as
`Scoped<R>` — the worst case a `scoped T` body is checked at, so the
body's scoped return satisfies the await-propagation and derivation
rules. And the collapse to `Scoped<R>` needs the `Scoped` declaration
to instantiate: the operator's `target` is set to that declaration
where the operator is declared (the checker requires `Scoped` in
scope), so `scopedFromTypeOf` in `types.zena` can build the real alias
without a checker context, and codegen's substitution — where the
wrapper erases anyway — collapses through the same rule.

## The flattening `then`, and what blocks it in the library

`Awaited<R>` was built to type a JS-like flattening `then` —
`then<R>(onValue: (v: T) => R): Future<Awaited<R>>`, with a runtime
future-test choosing between completing directly and chaining. The
test itself compiles (`v is Future<Awaited<R>>`, folded per
specialization), but the two uses after it do not, and both walls are
deliberate soundness rules rather than gaps:

- the else-branch needs `v as Awaited<R>` and the then-branch needs
  `v as Future<Awaited<R>>`, and the definition-site cast guard from
  the opaque-types work rejects casts to generic targets whose
  arguments are not supplied by the source — exactly the "trust me,
  it is identity at specialization" laundering it exists to block;
- proving the casts away would take the conditional-type reasoning
  ("in this branch, `Awaited<R> = R`") this design declines.

The clean path is `await` on a generic operand, now implemented:
`await x` accepts `x: T` open, typed `Awaited<T>`. Each specialization
sees a concrete operand — a future lowers through the existing
suspend, anything else through the union await's bare-value hop,
unconditionally. Unlike a union's bare arm, a bare `T` substituted to
a future is not a divergence: bare await means "await whatever
arrives". A concrete non-future operand at a use site is still an
error. With this, `then` IS a few lines of ordinary async code — an
async method, the first async code zena:async itself contains —
flattening the way JS's does with the type told by
`Awaited<R>`, and the then/flatMap waiter classes are gone
(`flatMap` folded into `then`). Cancellation forwards through the
frame the way it does everywhere, with no callback able to observe
it.

## `type.withDefault`

`WithDefault<T>` is `T` at a primitive and `T | null` at a reference.
It is the type of a slot a generic class keeps for a `T` it may not
have yet, such as `Future`'s value before it settles. Without it the
slot is `Box<T> | null`, an allocation per value, because `T | null` has
no representation at a primitive: `i32 | null` is not a type.

The closed forms follow from the argument's representation, through
enums and distinct aliases: `WithDefault<i32>` and `WithDefault<Color>`
are themselves, `WithDefault<String>` is `String | null`, and a type
that already admits null is unchanged.

While `T` is open the instance stays symbolic, and the checker allows
exactly what holds at every instantiation:

- a `T` is assignable to `WithDefault<T>`, and `null` is not;
- `defaultValue<T>(): WithDefault<T>`, the `default_value` intrinsic,
  is its empty value: zero at a primitive, null at a reference;
- `slot as T` reads the slot back, the identity at a primitive and a
  non-null cast at a reference, which fails on an empty slot. Nothing
  else reads it as a `T`.

`defaultValue` declares `scoped T`, since it takes no `T` and returns
an empty slot, so a `scoped T` class can use it. A `WithDefault<T>`
field of such a class is taken from like a nullable one
(ownership.md §"Scoped type arguments").

The rule that makes the operator necessary is enforced too (#614): a
type parameter not constrained to references may not be in a union with
anything else, `T | null` included (types.md §"Unbounded Type Parameters
in Unions"). Such a parameter can be bound to a primitive, and a
primitive's union with another type has no representation.
`WithDefault<T>` is the slot for an unconstrained `T`, and
`T extends anyref` the alternative for a parameter that is never a
primitive. An owner does not satisfy `anyref`, so a `scoped T` class that
holds owners uses `WithDefault<T>`.

Not yet implemented: a field of type `WithDefault<T>` still needs its
`= defaultValue<T>()` initializer, where a nullable `var` field may
omit `= null`.
