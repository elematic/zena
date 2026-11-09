# Refinement types

Status: **Proposed**

A refinement type is a type plus a predicate its values satisfy:

```zena
type Positive = i32 where (self > 0);
type Range = {lo: i32, hi: i32} where (self.lo <= self.hi);

function half(n: Positive): Positive {
  return (n >> 1) as Positive;
}
```

A `Positive` is an `i32` that is greater than zero, and a `Range` is a
record whose `lo` does not exceed its `hi`. The predicate is checked
where a value of the base type becomes a value of the refinement, and
from then on the type carries it: through calls, returns, fields,
collections and closures, with the type checker doing the work.

This document sets out the design. It is the second step of
[formal-verification.md](./formal-verification.md), after
[contracts.md](./contracts.md), and the step that makes the third, a
verifier, tractable.

## Why refinements after contracts

A contract clause states a property at one function:

```zena
function half(n: i32): i32 requires (n > 0) ensures (result > 0) { ... }
```

The precondition is checked at every call of `half`, and nothing a
caller knows about `n` travels with it: a caller that has already
checked `n > 0` checks it again, and a function that receives `half`'s
result and needs a positive number checks it a third time.

With `Positive`, the check happens once, where an `i32` becomes a
`Positive`. The type checker then does what the clauses did and more:
every caller of `half` has to hand it a `Positive`, every use of its
result knows it got one, an `Array<Positive>` holds only positives, and
none of that runs any code.

For a verifier the gain is larger. A verifier works one function at a
time, under assumptions about its parameters and about what each call
returns. Refinement types are those assumptions, in a form the type
checker already enforces, so the verifier never has to look across a
call. Its obligations shrink to the boundaries: the places where a
value takes on a refinement.

Clauses remain for what a refinement cannot say: a relation between two
values (`requires (lo <= hi)` between two parameters), a property of
mutable state (`requires (this.size > 0)`), and a change over time
(`ensures (this.count == old(this.count) + 1)`).

## Syntax

A refinement is declared as a type alias with a `where` clause:

```zena
type Positive = i32 where (self > 0);
type Percent = f64 where (self >= 0.0 && self <= 100.0);
type NonEmpty = String where (self.length > 0);
type Range = {lo: i32, hi: i32} where (self.lo <= self.hi);
type Sorted = (i32, i32) where (self[0] <= self[1]);
```

- `self` is the value being described, of the base type. It is a name
  only inside the `where` clause.
- The condition is an ordinary boolean expression over `self`, written
  in parentheses as a contract clause's condition is. It follows the
  same rules: a boolean, no assignment, no `await`.
- A refinement can be generic, with the base type's parameters:
  `type NonEmptyList<T> = ImmutableArray<T> where (self.length > 0)`.
- A refinement can refine a refinement, a distinct type or an opaque
  type, and the predicate then adds to what the base already says.

Refinements are declared, and named. An anonymous refinement in an
annotation (`n: i32 where (self > 0)`) is left out of this design; the
reason is under [Alternatives considered](#alternatives-considered).

## Semantics

### Values and subtyping

The values of `Positive` are the values of `i32` that satisfy its
predicate. A `Positive` is an `i32`: it is assignable wherever an `i32`
is, with no conversion, so `n + 1` on a `Positive` is ordinary
arithmetic and gives an `i32`.

The other direction needs evidence. An `i32` is not a `Positive` until
something shows it satisfies the predicate.

### Introduction

A value takes on a refinement in three ways:

- **A checked cast.** `x as Positive` evaluates the predicate on `x` and
  fails the way a contract clause fails: a `ContractError` whose message
  names the type and its predicate, `Positive requires (self > 0)`. The
  cast is the one place the check runs.
- **A literal.** `let p: Positive = 5;` is accepted when the checker can
  evaluate the predicate on the literal. The first version evaluates
  comparisons and arithmetic on numeric and string literals and refuses
  anything else, with the cast as the way out: `expensive() as Positive`.
- **A type test.** `if (x is Positive) { ... }` evaluates the predicate
  and narrows `x` to `Positive` on the true branch, as `is` narrows to a
  class. The predicate is a boolean expression, so a type test on a
  refinement is a run-time test, the same as a class test is.

A fourth way is what the verifier adds later: after
`if (x <= 0) { return 0; }`, `x as Positive` is justified by the flow
and its check can be deleted. The checker does not read predicates that
way itself.

### Identity

A refinement is a nominal type, as a distinct type is. Two declarations
with the same base and the same predicate are two types; a value of one
becomes a value of the other through a cast, checked against the
target's predicate. The verifier can later prove one predicate implies
another and make such a cast free, and that is a question for a
verifier, not for the type checker.

A refinement of a distinct or opaque type keeps the base's rules.
`type Depth = Meters where (self >= 0 as Meters)` can only be cast to
from a `Meters`, and an opaque base can only be cast to in its own
file, so an opaque refinement has one source of values and one
predicate at it.

### Representation

A refinement has its base's representation. No box, no tag, no field.
Specializations of generic classes are keyed by representation, and an
alias by its target, so `Array<Positive>` is the same specialization as
`Array<i32>`. Nothing is duplicated and nothing is boxed.

Generic classes are invariant, so an `Array<Positive>` is not an
`Array<i32>` and the other way around, as today for any two types. An
`ImmutableArray<Positive>` could be an `ImmutableArray<i32>` once
declaration-site variance allows it; the refinement adds nothing to
that question.

### Equality and hashing

A refinement's `==` and `hashCode` are its base's. Two values that are
equal as `i32` are equal as `Positive`.

## Which types can be refined

A refinement is a property of a value that cannot change. That is what
lets the type carry it: once `x as Positive` has passed, nothing can
make `x` negative. So a type can be refined when its values are
immutable in everything the predicate reads.

- **Primitives**: `i32`, `i64`, `f64`, `boolean` and the rest. Always.
- **`String`**: immutable, so always. `self.length`, `self.startsWith(…)`
  and the other methods are fine to call; what they answer cannot
  change.
- **Enums**: always, over the value or its backing number.
- **Records and tuples**: immutable, so always. The predicate reads
  fields and elements, through any depth of records and tuples:
  `type Line = {from: Point, to: Point} where (self.from.x <= self.to.x)`.
  A field of a mutable type is the exception below.
- **Classes**: a class value is a reference, and the object it names may
  change. A predicate over it is stable only if everything it reads is
  stable: fields declared immutable (the default), whose types are
  themselves refinable. `var` fields and the contents of mutable
  collections are out. The rule is the one the checker already applies
  to narrowing an immutable member path (language-reference.md,
  "Field and Element Narrowing"): what cannot be assigned can be relied
  on.

  ```zena
  class Interval {
    lo: i32;       // immutable: a predicate may read it
    hi: i32;
    var hits: i32; // mutable: a predicate may not
    new(this.lo, this.hi);
  }

  type Ordered = Interval where (self.lo <= self.hi);   // fine
  type Busy = Interval where (self.hits > 0);           // error: `hits` is mutable
  ```

  A class whose fields are all immutable and refinable is a record with
  a name, and refines like one. A class with mutable state wants a
  different construct: a **class invariant**, a condition on `this`
  that holds between method calls and is re-checked after each one.
  That is a contract on the class, not a type, and this design leaves
  it to its own document. Today its place is taken by the pattern Zena
  already has: a constructor with `requires` clauses and immutable
  fields, which gives an invariant by construction.

- **Collections**: `ImmutableArray<T>` is immutable, so it can be
  refined over its length and its elements. A `FixedArray<T>` has a
  fixed length and mutable elements, so a predicate may read its
  `length` and not its elements; `GrowableArray<T>` can change both and
  is not refinable. These are the general rule applied to the standard
  library's declarations: `length` is an immutable field on the first
  two and a getter over mutable state on the third.

- **Method calls** in a predicate are allowed on the same terms as a
  field read: on an immutable value (`String`, a record) any method; on
  a class value, only methods that read nothing mutable. The checker
  cannot see that from a signature, so the first version allows method
  calls on `String`, records, tuples and enums, and on classes only
  through immutable fields of those types. A method the compiler
  infers or checks to be pure ([pure-functions.md](./pure-functions.md))
  may be called on any path, since its body is known to read nothing
  mutable.

- **Function types** are not refined. A property of a function is a
  contract on its calls, which is what clauses on the function are.
- **Nullable types** are not refined by `!= null`: `T | null` already
  narrows to `T`, and a refinement over a nullable base must handle
  `null` in its predicate like any other value.

The checker enforces the stability rule where the refinement is
declared: a predicate that reads a mutable field, indexes a mutable
array, or calls a method on a class through a mutable path is an error
at the declaration, naming the path.

## Checking

- **The predicate** is checked as a boolean expression over `self`,
  with the stability rule above and the clause rules: no assignment,
  no `await`. It may call pure functions and pure methods
  ([pure-functions.md](./pure-functions.md)) and no others, since a
  predicate with effects would make a type test change the program.
- **Subtyping**: a refinement is assignable to its base, and to every
  type the base is assignable to. Nothing is assignable to a
  refinement without a cast, a passing literal, or a narrowing.
- **Casts**: `x as R` is accepted from `R`'s base, from any refinement
  of that base (through the base), and from a supertype of the base
  (which also checks the base's own cast). `r as Base` is a no-op and
  the lint reports it as unnecessary, as it does for an upcast.
- **Narrowing**: `x is R` narrows a binding or an immutable member path
  to `R` on the true branch and does nothing on the false branch. A
  `requires (x is R)` narrows `x` to `R` in the body, as any `requires`
  narrows. A `match` arm `case R:` is the same test.
- **Literals**: a numeric or string literal in a position typed `R`
  has `R`'s predicate evaluated on it at compile time when the predicate
  is built from comparisons, `&&`, `||`, `!` and arithmetic on `self`
  and literals, and `self.length` on a string literal. Otherwise the
  literal is an error there, and `as R` is the explicit form.
- **Contextual typing** of literals carries through: `let p: Positive =
5` and `half(5)` both type `5` as `Positive`.

## Running

The cast is the check. `x as R` compiles to `R`'s predicate on `x`, a
branch, and on the false side a call to `$contractFailed`, exactly the
shape a contract clause compiles to (contracts.md, "The check"), with
the message `Positive requires (self > 0)`. An `is R` compiles to the
predicate alone. Everything else about a refinement compiles to nothing:
its values are its base's values, and its types are erased to the base
before code generation, as distinct types are.

### `static` refinements

A `static` clause is one the compiler must prove at compile time
(contracts.md, "Kinds of clause"). A refinement can be marked the same
way:

```zena
static type Port = i32 where (self > 0 && self < 65536);
```

The marker restricts the predicate, not the casts. A `static`
refinement's predicate is limited to what the prover can reason about:
today the literal evaluator's subset of the language, comparisons and
arithmetic on `self` and literals, and `self.length` on a string; with
[pure-functions.md](./pure-functions.md), calls to pure functions whose
bodies are in that fragment. A predicate outside it is an error at the
declaration.

Casts to it behave as casts to any refinement. `x as Port` is free when
the compiler can show the predicate holds for `x`, and checked at run
time when it cannot; `is Port` tests and narrows. Run-time values enter
the type the same way they enter `Positive`: `parsed as Port` checks
`parsed` and throws when it is not a port, and `if (parsed is Port)`
tests it. Nothing is gained by refusing the cast, since the author who
writes it has asked for exactly the check it inserts, and refusing it
would make `static` types behave differently at the one place most
programs meet them, where input arrives.

What the restriction buys is that the type is usable wherever a proof
is demanded. A `static` clause, or a cast the verifier is asked to
discharge, can mention `Port` because the prover understands its
predicate, which it cannot promise for a predicate that calls a
function. And a cast whose operand the compiler knows is decided at
compile time: `8080 as Port` is proved by evaluation, and `70000 as
Port` is an error, not a throw, for a `static` refinement as for an
ordinary one whose predicate the evaluator happens to cover. Today the
prover is constant evaluation, so proofs come from literals and from
values already typed `Port`; a configuration record whose fields are
`Port`s is checked when it is written down, and `parsed as Port` keeps
its run-time check. When the verifier arrives,
`if (p > 0 && p < 65536) { return p as Port; }` is proved from the flow
and the check goes away.

|                                                | any refinement              |
| ---------------------------------------------- | --------------------------- |
| `x as R`, `x` not proved                       | checked at run time; throws |
| `x as R`, `x` proved (literal, flow, verifier) | free                        |
| `x as R`, `x` a literal that fails             | error                       |
| `if (x is R)`, `case R:`                       | tests and narrows           |

`static` changes none of these rows. It changes which predicates the
type may have, so that the first row can become the second wherever a
proof is possible, and so that a `static` clause may speak of the type.

A `debug` modifier on a refinement is not in this design. A type whose
casts are skipped in some builds is a claim the type system would then
rely on without evidence, in exactly the builds that run.

## The verifier's obligations

With refinements in place, a verifier has three kinds of obligation,
and they are the whole list:

1. **A cast `x as R`**: show that `R`'s predicate holds for `x` at that
   point, from the types in scope and the flow that reaches it. Proved,
   the cast's check is deleted. Not proved, the check stays, unless the
   cast is inside a `static` clause, where it is an error like the rest
   of the clause.
2. **A `static` clause**: show that it holds. There is no check to
   delete; a failure is an error.
3. **An unmarked clause**, when asked: as a cast, show it and delete its
   check.

Every call in a body contributes an assumption and nothing else: its
arguments' types are what the callee requires, and its result's type is
what the callee ensures. That is the modular verification SPARK and
Liquid Haskell do, and refinement types are why it is modular.

The theory is wasm's: `i32` arithmetic wraps, so the solver reasons in
bit-vectors, and answers questions about the code that runs rather
than about mathematical integers. That is the main open question for
the verifier's own design, and this document does not settle it.

## Alternatives considered

### Anonymous refinements in annotations

`function half(n: i32 where (self > 0)): i32 where (self > 0)` would
spare a declaration. It raises the ambiguity contracts.md avoided: a
return type followed by `where (…)` and then `{` or `=>`, and a
parameter type followed by one and then `,`. The parentheses would
keep it parseable, but an unnamed refinement has no identity to reason
about, no name in a message, and no place for a doc comment. Declaring
it is the better default, and a `where` on a parameter can be added
later as sugar for a declaration if it earns its place.

### Structural identity

Two refinements with the same base and predicate could be the same
type. Deciding that means deciding predicate equivalence, which is the
verifier's problem, and settling for textual equality would make
`self > 0` and `0 < self` different types anyway. Nominal identity is
what distinct types already do, and casts between refinements are
checked, so nothing is unsound in the meantime.

### Implicit checked conversion

`let p: Positive = n;` could insert the check. Zena has no implicit
coercion and no unchecked cast, and a conversion that can fail at run
time should be visible where it is written, as a downcast is. The cast
stays explicit; the verifier makes it free, not invisible.

### `where` on a class declaration

`class Interval where (self.lo <= self.hi)` would make the predicate an
invariant of every instance. That is a class invariant: it has to be
checked after every mutation, not at a boundary, and it belongs to
contracts rather than types. It gets its own design.

### The name `self`

`self` is new as a name. `this` means the receiver and would read as a
method's; `it` and `$` (the pipeline placeholder) were considered and
are either foreign or taken. `self` is contextual inside `where` only.

## Open questions

- **The literal evaluator.** How much of a predicate the checker
  evaluates on literals. Comparisons and arithmetic on numeric literals
  cover `Positive`, `Percent` and ranges; `String` methods beyond
  `length` likely do not pay for themselves. For a `static` refinement
  this subset is also the whole predicate language until the verifier
  widens it.
- **Narrowing from a predicate's own text.** `if (x > 0)` could narrow
  `x` to `Positive` without a cast if the checker matched the condition
  against the predicate. It is a small verifier, and the real one
  subsumes it; the question is whether a syntactic version is worth
  having first.
- **Refinements in patterns.** `case Positive:` is a type test. Whether
  a refinement can also appear inside a record or tuple pattern
  (`case {lo: Positive}`) is open.
- **Pure methods.** Allowing a class method in a predicate needs the
  compiler to know it reads nothing mutable. The `pure` modifier of
  [pure-functions.md](./pure-functions.md) is that notion; what is open
  here is only whether a predicate may call an unmarked method on an
  immutable value, as the first version allows, once the modifier
  exists.
- **Interaction with `inline`.** An `inline (i32, i32)` is a tuple with
  a representation; whether `type Sorted = inline (i32, i32) where (…)`
  keeps the inline representation, or whether `inline` applies to a
  refinement of a tuple, follows the rules in inline-parameters.md and
  is not yet written down.

## Implementation steps

1. The declaration: `type R = Base where (…)`, parsed, with `self`
   bound, the predicate checked as a clause condition, and the
   stability rule for the base and the paths the predicate reads.
2. Subtyping to the base; `as R` as a checked cast compiled through the
   clause check; `is R` as a test; erasure to the base in codegen.
3. Narrowing from `is R`, in `if`, `requires` and `match`.
4. Literals: the evaluator for numeric and string predicates, and
   contextual typing. With it, `static type`: the predicate restricted
   to the evaluator's subset.
5. Records, tuples and immutable classes as bases; generic refinements.
6. The formatter, the language reference and the website.

Each step lands with portable tests; the first two are enough to write
`Positive` and use it across a program.
