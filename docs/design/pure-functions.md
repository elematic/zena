# Pure functions

Status: **Partly implemented.** Inference, and the check on `static`
clauses and `old`, are in the compiler
(`packages/zena-compiler/zena/lib/analysis/purity.zena`). The `pure`
modifier, the evaluator, the lint and the hover are not; see
[Implementation steps](#implementation-steps).

A pure function is one the compiler may reason about as a mathematical
function: its result depends on its arguments alone, and calling it
changes nothing.

```zena
function isPort(n: i32): boolean {
  return n > 0 && n < 65536;
}

static type Port = i32 where (isPort(self));

function listen(port: i32) static requires (isPort(port)) { ... }
```

The compiler infers purity from a function's body: `isPort` reads only
its parameter and calls nothing, so it is pure, and the predicate and
the `static` clause may call it. A pure function may be called from the
places where the compiler has to do more than run code: `static`
contract clauses, which are proved rather than checked at run time
([contracts.md](./contracts.md), "Kinds of clause"); the predicates of
refinement types ([refinement-types.md](./refinement-types.md)); and
`old(…)` in a postcondition. A function may also say it is pure, with
a `pure` modifier the compiler checks, so that the promise is part of
its signature and a change that breaks it is an error at the function.
This document sets out the rule, how purity is inferred and declared,
what it unlocks, and why it is purity and not compile-time evaluation.

## Why purity

A `static` clause is proved, not run. When `listen` says
`static requires (isPort(port))`, the compiler has to show the
condition for every call, with `port` unknown, and it can only do that
by unfolding `isPort`: reasoning about its body with `n` standing for
the argument. That is possible only when the body means the same
thing every time it is called, which is what purity guarantees.
Constant evaluation, the first prover, is the special case where the
argument is a literal: unfolding `isPort(8080)` is running it. So the
one property the compiler needs is that the function has no effects
and reads nothing that can change; being evaluable at compile time
follows from it.

The same property is what a refinement predicate needs.
refinement-types.md allows a predicate to call methods only on
immutable values, because the checker cannot see from a signature
whether a method reads mutable state, and leaves "a notion of a pure
method" as an open question. Purity is that notion: a class method the
compiler knows to be pure may appear in a predicate, and the stability
rule (refinable means immutable in what the predicate reads) extends
through the call to what the method reads.

Dafny separates `function` (pure, usable in specifications) from
`method`; SPARK has expression functions and `Pure` aspects; Liquid
Haskell reflects a pure Haskell function into its logic. Each of them
found that the specification language and the programming language can
be one language, with purity as the border between them.

## Three grades

"Pure" has meant two things in this repository's designs, and the
verifier needs a third. [macros.md](./macros.md) calls a macro "a pure
function over ASTs" and means that it touches nothing outside itself:
no files, no network, no module state; it builds and mutates AST nodes
freely. [dead-code-elimination.md](./dead-code-elimination.md) sketches
a `@pure` module decorator and means that initializing the module has
no effects, so its unused exports can be dropped. Neither notion lets a
prover unfold a call, and a function the prover can unfold is stricter
than both. The grades, from weakest to strongest, are D's weak and
strong purity with Dafny's specification functions on top:

| grade                      | the body                                                                                 | who needs it                                                            | demanded by                 |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------- |
| **effect-free**            | reads and writes nothing but its parameters and what they reach, and what it allocates   | macros, dead-code elimination, calls on fresh objects inside pure code  | a `macro` declaration       |
| **pure**                   | effect-free, reads only immutable paths of its parameters, writes only what it allocates | predicates, evaluation, memoization                                     | the `pure` modifier         |
| **specification function** | pure, terminates, and is in the prover's fragment                                        | symbolic proof: unfolding in `static` clauses, `static type` predicates | a `static type`'s predicate |

An effect-free function is referentially opaque: `GrowableArray.push`
is effect-free, since it writes only through `this`, and two calls of
it on the same array give different results. A pure function is
referentially transparent: its result is a function of its arguments'
immutable contents, so a call can be replaced by its value, evaluated
at compile time, memoized or reordered. A specification function is a
pure function the solver can also reason about with unknown arguments.

A `static` condition and the argument of `old` are held to a property
that is none of the three grades: evaluating them **changes nothing**.
`static requires (index < this.length)` on a growable array reads a
field that can change, so it is not pure, and it is what a
precondition on a mutable object looks like. The condition is about
the object's state at the point of the clause, as a Dafny function
with a `reads` clause is, and what the compiler needs from it is that
it only reads. See [Where purity is required](#where-purity-is-required).

No grade has a keyword of its own. Each is inferred for every
function, and where a program needs a body to have a grade, the
declaration that needs it makes the demand and the checker verifies the
body against it:

- A **`macro` declaration** demands an effect-free body. A macro is a
  function from syntax to syntax that the compiler runs, and a
  declaration kind for it, in the way `decorator` is one
  ([decorators.md](./decorators.md), "The declaration"), says what the
  thing is and what its body may do at once: a macro's body may call
  anything the compiler infers effect-free, build and mutate the syntax
  it returns, and reach nothing outside its parameters. The form of
  the declaration is macros.md's to settle. What keeps a macro from
  files and the network is the restriction on what a macro module may
  import, a capability rule that macros.md keeps, since an effect-free
  body can still call a `declare function` the host implements.
- The **`pure` modifier** demands a pure body. It is the one grade with
  a modifier rather than a declaration kind, because a pure function is
  an ordinary function in every other respect, and the mark is a
  promise to callers who memoize, evaluate or prove.
- A **`static type`'s predicate** demands a specification function
  (refinement-types.md, "`static` refinements"), and the prover decides
  from the body whether it has one.

Dead-code elimination needs no declaration: the compiler has every
body when it links a program, and infers the grade of each module's
initializers. The effect-free grade is otherwise internal; it is how a
pure function gets to call `push` on an array it just allocated.

## Inference

Whether a function is effect-free or pure is a fact about its body, and
the compiler computes both grades in one pass: a function is pure when
its body follows [the rule](#the-rule) below and every function it
calls is pure, or effect-free where the rule allows. The computation is
a walk of the body and a fixpoint over the callees, in the shape of the
capture analysis (`analysis/capture.zena`); a cycle of recursive
functions is assumed pure while it is being decided and demoted if any
member turns out not to be. The answer is remembered per function and
asked for on demand: when a `static` clause or a
predicate calls `isPort`, the checker walks `isPort`'s body then, which
lazy body checking ([lazy-body-checking.md](./lazy-body-checking.md))
already allows, and the same on-demand walk is what the evaluator
needs. The clauses of a compilation are judged after every library in
it is checked, since a body a clause calls may be in a library that
is checked later, and an incremental check judges them again whenever
any library is checked again: a body can change without its library's
export signature changing.

Two kinds of call cannot be inferred from the caller's side. A call
through an interface reaches any implementation, which the checker
cannot enumerate without the whole program, so it is pure only when the
interface method is declared `pure`, which obliges every
implementation. A call through a function value reaches code the
compiler does not see, so it is impure, until function types carry
purity (see [Open questions](#open-questions)).

Inference means the standard library needs no annotation for its
functions to be usable in predicates and `static` clauses: of its
roughly nine hundred top-level functions and a thousand methods, the
ones a predicate calls are pure already, and the compiler sees that.
The negative answer is as useful as the positive one, and the compiler
keeps the reason: _not pure: assigns `this.#count` (line 12)_, or _not
pure: calls `log`, which calls `print`, which writes to the console_.
That trace is the error a `static` clause gets when it calls an impure
function, the language service's answer on hover over a function, and
the explanation a lint gives.

## Declaration

A function may also declare that it is pure, and the compiler checks
the declaration against the body with the same rule, so a body that
reads mutable state, assigns a field or calls an impure function is an
error at the function. A declared `pure` is a promise in the signature,
and the reason to make one is a boundary: a `static` clause in one
package that calls an inferred-pure function in another depends on that
function's body, and a change to the body that adds a cache or a log
line breaks the caller's build with an error that points into the
dependency. The mark moves the error to the function that changed. The
lint rule below adds it to the public functions of a package that are
pure, so a package's API declares itself, and inside a library nothing
needs the mark.

`pure` is a modifier in the position `async` takes, before `function`
on a declaration and before the name of a method:

```zena
pure function gcd(a: i32, b: i32): i32 { ... }

class Interval {
  lo: i32;
  hi: i32;
  new(this.lo, this.hi);
  pure contains(x: i32): boolean { return this.lo <= x && x <= this.hi; }
}

interface Shape {
  pure area(): f64;
}
```

A `pure` method in an interface requires every implementation to be
pure, so a call through the interface is a call to a pure function; it
is the one place the mark is needed rather than optional. A `pure`
method in a superclass may be overridden only by a pure one, and an
inferred-pure method may be overridden by an impure one, in which case
a call through the superclass type is impure.

Arrow functions are not marked. They are values, and a call through a
function value is a call to code the compiler does not see, so a pure
function cannot call one. A pure function may take a function-typed
parameter only to return it or store it in its result, never to call
it. Function types do not carry purity in this design; see
[Open questions](#open-questions).

`pure` is a contextual keyword. It is read as a modifier only directly
before `function`, or before a method name in a class or interface
body, so a variable or field named `pure` keeps working.

### The lint and the hover

Two tools surface inferred purity:

- A lint rule in `packages/zena-lint`, `declare-pure`, reports an
  exported function or a public method the compiler infers pure and
  that does not say so, and its fix adds the modifier. `zena lint --fix`
  over a package marks its API in one pass, and the fix is kept only
  when the result type-checks, as every zena-lint fix is. The rule is
  off for functions that are not exported; purity inside a library is
  the compiler's business.
- The language service shows purity on hover over a function or method:
  _pure_ (inferred or declared) or _not pure_, with the trace. A
  function's author sees why it could not be called from a predicate
  before writing the predicate.

## The rule

One walk of a body records four facts about it, each with the first
place the walk found it:

| fact             | the body                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **effect**       | changes something outside its arguments, or does something the analysis does not follow: assigns a module or static variable, calls a host function, a function value or a method through an interface, awaits, yields |
| **state read**   | reads a module or static `var`, or a module-level value that can change, such as a module `let` that holds an array                                                                                                    |
| **write**        | assigns a field or an element of an object that existed before the call                                                                                                                                                |
| **mutable read** | reads a `var` field, or an element of an array that can change, of an object that existed before the call                                                                                                              |

A body with no effect and no state read is **effect-free**. A body
with none of the four is **pure**. A body with no effect and no write
changes nothing, which is what a `static` condition and the argument of
`old` need. A module `let` of an immutable type, a number or a `String`
or a record of them, is a constant, and reading it is none of the four.

### Calls and fresh objects

A call gives the calling body the callee's effect and state read. The
callee's write and mutable read are about the objects it was handed,
so whether they are the caller's depends on what the caller handed
over:

```zena
function squares(n: i32): GrowableArray<i32> {
  let out = new GrowableArray<i32>();
  for (var i = 0; i < n; i += 1) {
    out.push(i * i);
  }
  return out;
}
```

`push` writes through `this`. Here `this` is an array `squares`
allocated, which no caller has seen, so `squares` is pure. With a
parameter `items`, `items.push(x)` is a write.

The walk tracks which locals hold **fresh** objects: a `let` local
bound to a `new` expression, an array literal or an array allocation.
A `var` local is never fresh, since it can be reassigned to alias a
parameter, and a call's result is not fresh, since a function may
return an object it did not allocate, such as a module `let`. A value
is **detached** when the caller cannot reach it by another path: a
value of an immutable type, an allocation whose arguments are
detached, or something reached from a fresh local. An assignment to a
field or element of a fresh local is not a write, and a call whose
receiver and arguments are all detached takes on neither the callee's
write nor its mutable read. So a pure function may hand a fresh array
to a helper that fills it.

A fresh object can come to hold something the body did not make:

```zena
function clobber(items: FixedArray<i32>): boolean {
  let holder = new Holder(items);
  holder.items[0] = 0; // the caller's array
  return true;
}
```

`new Holder(items)` is not detached, because `items` is not. When a
body binds a fresh local to an allocation that is not detached, or
stores a value that is not detached in an object it allocated, the
walk counts only the fresh locals themselves as the body's own, in the
whole of that body: `holder` is, and `holder.items` is the caller's.
This is coarser than tracking which local holds what: one such store
anywhere in a body makes every path through every fresh local of that
body the caller's.

A callee can also reach module state by itself:

```zena
let shared = new Counter();

function plant(slot: Slot): void {
  slot.counter = shared;
}

function planted(): boolean {
  let slot = new Slot();
  plant(slot);
  return slot.counter.increment() > 0; // increments `shared`
}
```

`plant` has a state read and a write, and its verdict does not say
whether it wrote the module's object or stored it in what it was
handed. So at a call that hands over only detached values, a callee
with both a state read and a write counts as an effect of the caller.
The cost is a function that reads a module-level table and fills an
array it was given: calling it is an effect even with a fresh array.
For the same reason a `new` expression is detached only when the
constructor has no state read.

A constructor's body is walked with `this` as an object the body
allocated, which is what the usual initializer list assigns.

### What the analysis does not follow

Each of these is recorded as an effect, or as the fact named, where a
finer analysis could show there is none:

- A call through a function value or an interface, and iteration with
  `for`/`in` over anything but an array or an `i32` range, which calls
  the iterator through an interface.
- The `eq`, `hash` and `to_string` intrinsics on a value of a type
  parameter, which call a method the analysis cannot name. A hash
  map's methods use them, so reading a `HashMap` is an effect, and so
  is a map literal and a template literal that formats a value that is
  not a number, a `boolean` or a `String`.
- A module variable a function fills on first use. Whoever calls the
  function sees one result, and the analysis sees an assignment.
- `items.push(shared)` on a fresh `items` makes `items` hold a value
  the body did not make, and the walk does not see through `push` to
  know it, so it counts as a write.
- In a constructor, a call of a method or setter on `this`, and an
  assignment to an element of one of its fields, count as writes.
- Destructuring a value whose type the analysis cannot name is a
  mutable read, and a destructuring assignment is a write.
- A field assignment that a subclass's setter overrides is counted as
  the field's own.
- Constructing an `Error` captures a stack trace, which is not counted.

For an inferred function, the first of each fact is kept as the
reason, for the trace. For a declared `pure` function, each
violation of purity is an error at the expression, naming what it
reads, writes or calls. The checker applies the rule by walking the
body, which the clause checks already do for assignment and `await`
(`checker/contracts.zena`). A `requires` or `ensures` clause on a pure
function may call only pure functions as well, since the clause is
part of the function's meaning.

The fresh-local rule is a syntactic stand-in for escape analysis. It
covers building a result in a `GrowableArray` or a `StringBuilder`,
with or without a helper, and returning it, which is most of what a
pure function would want to mutate. What it gives up is listed under
[Open questions](#open-questions).

Throwing is allowed in both grades. A pure function that throws is partial, and the
prover treats a call that throws as a condition that does not hold.
Trapping arithmetic (`div` by zero, an out-of-range cast) is the same
case.

## Where purity is required

- **`static` clauses.** The condition of a `static requires`, `ensures`
  or `invariant` may change nothing: it may read fields, elements and
  module variables that can change, and call functions that do, and it
  may not have an effect or write to an object. A proof is about the
  state at the clause, as it is for a comparison of two `var` fields,
  so a read needs no restriction; a write or an effect would make the
  program depend on a condition that is never run. The error carries
  the trace:

  ```
  A 'static requires' condition cannot have effects: it calls
  'positive', which assigns the module variable 'calls'.
  ```

  The compiler checks this and still does not prove the condition;
  that is the evaluator's step, below.

- **Refinement predicates.** A predicate may call pure functions, and
  pure methods on `self` or on what it reads from `self`, on top of
  what refinement-types.md allows. A `static type`'s predicate must be
  pure throughout; an ordinary refinement's predicate too, since a
  predicate with effects would make a type test change the program,
  and the checker rejects an impure call in either.
- **`old(…)`.** The argument of `old` is evaluated at entry and kept.
  It may change nothing, so that evaluating it early cannot be
  observed. It exists to read state that the body is about to change,
  so reads of that state are what it is for.
- **Unmarked and `debug` clauses.** Unchanged: they may call any
  function, as contracts.md says, and nothing checks for effects. A
  lint can suggest `pure` on a function that every clause calls and
  that satisfies the rule.

## Evaluation and proof

Purity gives the compiler two things, in two layers.

**Evaluation.** A pure function whose arguments are known at compile
time can be run there. That is how a `static` clause is proved before
there is a verifier, and how a cast to a refinement with a known
operand is decided: `8080 as Port` evaluates `isPort(8080)`, and
`70000 as Port` is an error at the cast. The evaluator is the literal
evaluator the checker already has for `Positive`-style predicates,
extended to calls: it interprets the body of a pure function over a
value domain of primitives, `String`, enums, records, tuples and arrays
of those, and instances of classes with pure constructors. It lives in
the checker because that is where casts and `static` clauses are
checked; a cast's operand is known there and the predicate's body is
available through lazy body checking
([lazy-body-checking.md](./lazy-body-checking.md)).

The evaluator has a fuel limit. A call that runs out of fuel is not
proved, and for a `static` clause that is an error saying the clause
could not be evaluated. The limit is a count of steps, generous enough
for anything a predicate should do and small enough that a compile
never hangs on a loop that was not meant to end.

The same interpretation, run over ZIR instead of the AST, would give
the optimizer interprocedural constant folding: a call to a pure
function with constant arguments folds to its result in every build,
not only in a clause. That is a separate piece of work on
[optimization-pipeline.md](./optimization-pipeline.md), and purity is
what makes it sound.

**Proof.** With a verifier, a pure function's body can be unfolded
with symbolic arguments. `isPort(port)` for an unknown `port` becomes
`port > 0 && port < 65536`, which the solver decides from what it
knows about `port`. That needs more than purity: the body has to be in
the fragment the solver handles, and it has to terminate. That is the
third grade of [Three grades](#three-grades), the specification
function, and the compiler tells it from a pure function by looking at
the body:

| the body is              | the compiler can                              |
| ------------------------ | --------------------------------------------- |
| pure                     | evaluate it on known arguments                |
| a specification function | evaluate it, and reason about it symbolically |

A `static type` requires a specification function for its predicate,
which is what refinement-types.md means by "what the compiler can
evaluate": with pure functions the phrase becomes "pure, total, and in
the prover's fragment". An ordinary refinement needs only a pure
predicate. A predicate that calls a regex match is pure and evaluable
on a literal, and is out of any bit-vector solver's reach; it may
refine a type, and may not refine a `static` one. Writing to a fresh
`GrowableArray` is pure and likewise outside the fragment, so a
specification function is in practice an expression over its
arguments, calls to other specification functions, and recursion. The
fragment itself is the verifier's design and is not fixed here; the
literal evaluator's subset is its first approximation.

## Totality

A pure function that does not terminate is a problem for proof and not
for evaluation: the evaluator runs out of fuel and reports it, while a
prover that unfolds `f(x)` without knowing `f` terminates can derive
anything. Dafny requires a decreasing measure on every recursive
function and checks it; Liquid Haskell does the same with a
termination metric, and both let the author turn the check off.

This design does not decide the totality rule. Until the verifier,
fuel is the whole story. When it arrives, the choice is between a
measure the checker can find itself (a structurally decreasing
argument, which covers most predicates), one the author writes, and
trusting the mark; see [Open questions](#open-questions).

## Alternatives considered

### A compile-time marker

Zig's `comptime` and C++'s `constexpr` name the ability to run a
function during compilation. That ability is what `static` clauses use
today, so marking it directly was the obvious design. It names the
wrong property. Proof, which `static` clauses are for, needs a function
that can be unfolded with unknown arguments, and a compile-time marker
promises nothing about a call with unknown arguments; purity does, and
compile-time evaluation follows from it. Zig's marker is also at the
call site, so an impure body would be reported wherever a `static`
clause calls it, far from the body. And Zig's `comptime` is a
metaprogramming system, with types as values and comptime parameters
in place of generics, of which this design would borrow one feature.

### Dart's `const`

Dart's `const` makes canonical, deeply immutable object values, built
by `const` constructors from a fixed grammar of expressions, with no
user functions in it at all. Zena's records, tuples and case classes
are already immutable values, a module `let` with a literal
initializer is already a constant, and a constant expression in Zena
would be exactly an expression over literals and pure functions. The
keyword would name a consequence of this design.

### Declared purity only

Dafny, SPARK, D and Rust (`const fn`) require the mark: a function is
usable in a specification only when it says so, and the mark is the
function's promise, as `async` is in Zena. The argument for it is the
boundary case under [Declaration](#declaration): without a mark, a
`static` clause in one package depends on a body in another. Against
it is the standard library, whose roughly nineteen hundred functions
and methods would each need the mark before a predicate could call
them, and every new one after; a property the compiler can compute
should not be typed by hand nineteen hundred times. Koka infers effects
and lets authors annotate, and TypeScript infers return types and lets
authors declare them at the boundaries they care about; this design
takes that stance, with the `declare-pure` lint putting the marks at
the boundaries.

### An effect system

The three grades are points on an effect lattice, and
[ai-first-language.md](./ai-first-language.md) sketches tracking
effects in the type system (`IO<String>` as a result type). A general
effect system (`throws`, `allocates`, `reads`, `writes` as tracked
effects, with per-parameter write sets) would subsume this design, and
would be a far larger change to the type system, the standard library's
signatures and every function type. Nothing in contracts, refinements,
macros or dead-code elimination needs more than the three grades, and
the `pure` marker can become an effect annotation later without
changing what it means.

## Open questions

- **Widening freshness.** A verdict says that a function writes and
  not through which parameter, or whether what it stores came from
  module state. So one store of a shared value in a body's own object
  costs every fresh local of that body its paths, a helper that reads a
  module-level table and fills the array it is handed is an effect at
  every call, and a call's result is never fresh. A per-parameter
  notion of which arguments a function writes through and what it
  returns (D's `pure` with mutable parameters, Rust's `&mut`) would
  remove all three, at the cost of that information in every verdict
  and, for declared functions, on every signature.
- **Macros and mutation of their arguments.** An effect-free macro may
  write through the syntax it is given, which hygiene (macros.md, "No
  Variable Capture") may or may not want. Whether a macro's parameters
  are immutable syntax, so that a macro is in effect pure over them, is
  macros.md's question.
- **Function types.** A pure function cannot call a function value.
  `pure (x: i32) => boolean` as a type would let a pure higher-order
  function (`all`, `any` over an array) exist, and let a predicate pass
  a pure arrow. The cost is purity on every function type and arrow.
- **Totality.** Whether the verifier requires a measure, finds one, or
  trusts the mark, and whether `pure` should imply total or a second
  marker should say so.
- **The standard library's marks.** Inference makes its functions
  usable without any, so the question is only whether to run
  `declare-pure` over it and commit the result. A marked API is a
  stable one, and the marks document which `String`, `Math` and array
  methods a predicate may call; against that, a large diff and a mark
  on every new pure function. The intrinsics purity rests on
  (comparisons, arithmetic, `String.length`) are pure by declaration in
  the compiler either way.
- **Generic pure functions.** A pure function over `T` may call a
  method of `T` only through an interface whose method is `pure`.
  Whether the constraint can say so (`T extends Comparable` where
  `compare` is pure) or needs a `pure` bound of its own.
- **Purity of `==` and `hashCode`.** A class's user-written `==` is a
  method the compiler calls implicitly in patterns and collections;
  a pure function comparing two class values needs it pure. Whether
  that is required of every `==` or only of those pure code reaches.

## Implementation steps

1. Inference: the body walk and the callee fixpoint, remembered per
   function and asked for on demand, with the trace for a negative
   answer; the intrinsics and constructors it treats as pure. **Done.**
2. The requirement: `static` clauses and `old` arguments may change
   nothing, with the trace in the error. **Done.** Refinement
   predicates, which must be pure, get the same check when refinement
   types are implemented.
3. The modifier: parsed before `function` and before a method name,
   stored on the declaration and the signature, checked against the
   body, printed by the formatter, and the interface and override
   rules.
4. The evaluator: the literal evaluator extended to calls, with fuel;
   `static` clauses proved by evaluation where their operands are
   known, casts to refinements decided at compile time where theirs
   are, and an error where a `static` clause cannot be evaluated.
   This closes the gap in which today's compiler accepts a `static`
   clause without proving it.
5. The `declare-pure` lint, the hover in the language service, and the
   language reference and website.

Each step lands with portable tests. The first two are what
`static type Port = i32 where (isPort(self))` needs from this design to
be declared and checked against an unmarked `isPort`; the fourth makes
`8080 as Port` free and `70000 as Port` an error.
