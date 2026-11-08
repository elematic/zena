# Contracts

Status: **Implemented**, with the gaps listed under
[Where clauses are not supported yet](#where-clauses-are-not-supported-yet)

A contract is a condition written on a function or a loop that the
program is expected to keep: a precondition (`requires`), a
postcondition (`ensures`) or a loop invariant (`invariant`).

```zena
function withdraw(account: Account, amount: i32): Account
  requires (amount > 0)
  requires (account.balance >= amount)
  ensures (result.balance == account.balance - amount)
{
  ...
}
```

Contracts are the first step of the plan in
[formal-verification.md](./formal-verification.md): conditions that are
checked when the program runs, in a form a static verifier can later
prove.

The parser accepts the syntax in this document, the checker applies the
rules under [Checking](#checking), and every clause the checker accepts
is compiled to the check under [Running a clause](#running-a-clause).
Where a clause cannot be compiled yet, the checker reports it: a
program cannot contain a contract that is silently ignored.

## Syntax

### Functions

A clause is a keyword followed by a condition in parentheses. The
clauses of a function come after its parameters and return type, and
before its body.

```zena
// A function declaration
function half(n: i32): i32 requires (n % 2 == 0) {
  return div(n, 2);
}

// An arrow function: the clauses come before `=>`
let abs = (x: i32): i32 ensures (result >= 0) => if (x >= 0) x else -x;

class Stack<T> {
  // A constructor: the clauses come before the initializer list
  new(capacity: i32) requires (capacity > 0) : #items = new Array<T>(capacity) {}

  // A method
  pop(): T
    requires (this.length > 0)
    ensures (this.length == old(this.length) - 1)
  {
    ...
  }
}

// A method without a body: in an interface, or `abstract`
interface Shape {
  area(): f64 ensures (result >= 0.0);
}
```

A function can have any number of clauses, in any order. The condition
is an ordinary expression. A `requires` condition can name the
function's parameters and, in a method, `this`. An `ensures` condition
can also name `result` and call `old`.

Clauses are not accepted on `declare function`, on accessors, or on an
interface's constructors.

### Loops

A loop's `invariant` clauses come after its header and before its body.
The condition holds each time the loop is about to test whether to run
again, including the first time.

```zena
while (lo < hi)
  invariant (0 <= lo && lo <= hi && hi <= items.length)
{
  ...
}

for (var i = 0; i < n; i += 1) invariant (total >= 0) { ... }

for (let item in items) invariant (total >= 0) { ... }
```

A loop with `invariant` clauses takes a block as its body.

### `result` and `old`

Inside an `ensures` condition, `result` is the value the function
returned. It is a name only there: a function can still have a local
variable called `result`.

`old(e)` is the value `e` had when the function was entered. A
postcondition on a method that changes its object needs it:
`ensures (this.length == old(this.length) - 1)`.

Both parse as an ordinary identifier and an ordinary call. The scope
builder and the checker give them their meaning.

### Contextual keywords

`requires`, `ensures` and `invariant` are not reserved words. Each is a
keyword only in the position where a clause can stand:

- After a signature, nothing but a body, `=>` or `;` is valid, so a
  name there has no other reading. `requires` or `ensures` in that
  position starts a clause.
- After a loop header the body follows, and a body can be any
  statement, so `while (c) invariant(x);` is a loop whose body calls a
  function named `invariant`. The word starts a clause only when its
  parenthesized condition is followed by `{` or by another `invariant`
  clause. A call statement is followed by `;`, so the two never
  overlap. This is why a loop with clauses takes a block.

### Formatting

When the clauses fit on the line of the signature or loop header, the
formatter keeps them there. Otherwise each clause takes its own line,
indented, and the `{` or `=>` that starts the body takes a line of its
own, as in the `withdraw` example at the top of this document. Line
breaks carry no meaning.

## Checking

### Conditions

A condition is checked as a boolean expression, like the condition of
an `if`. It cannot contain an assignment or an `await`: a clause can be
left out of a build (see [Kinds of clause](#kinds-of-clause)), and a
condition that assigns or suspends would make the program behave
differently without it. A condition can still call a function that has
effects; nothing checks for that yet.

### Names in scope

A `requires` condition sees what the body sees on entry: the
parameters, `this` in a method, and the names around the function. The
body's own variables do not exist yet. A constructor's `requires`
condition cannot use `this`: it runs before the field initializers,
when there is no object.

An `ensures` condition sees the same names and `result`. Each `ensures`
clause has a scope of its own that declares `result`, so the name
exists nowhere else, and a local variable called `result` in the body
is unrelated to it. A parameter called `result` would be hidden in the
condition, so a function with an `ensures` clause cannot have one.

An `invariant` condition sees what the loop's condition sees. That
includes the variable a `for` loop declares in its header. It excludes
the variable of a `for`-in loop and anything a `while (let ...)`
condition binds, because the invariant holds before those are bound.

### The type of `result`

`result` has the function's return type, whether declared or inferred
from the body. An `async` function's `result` is the value its future
completes with. A function that returns nothing has no `result`, and
neither has a constructor, whose new object is `this`, or a generator,
whose body returns nothing.

### `old`

`old(e)` has the type of `e`. It is the entry-value operator only
directly in an `ensures` condition, where it hides any function named
`old`. In a function written inside the condition, `old` is an ordinary
name, because `e` would be evaluated on entry, before that function's
parameters exist. `e` cannot name `result` or contain another `old`.

### What a precondition narrows

A precondition is checked on every call, and a call that fails it does
not reach the body. So what its condition narrows when it is true holds
in the clauses after it and in the body, exactly as the test of an `if`
narrows in its consequent:

```zena
function adopt(a: Animal): i32
  requires (a is Cat || a is Dog)   // a is a Cat | Dog from here on
{
  let pet: Cat | Dog = a;
  ...
}

function purr(a: Animal): i32
  requires (a is Cat)
  requires (a.purrs())              // a later clause sees it too
{
  return a.meow();
}

let size = (text: String | null) requires (text != null) => text.length;
```

The condition engine is the one `if` uses, so the same things narrow: a
binding, and a member path through fields that cannot be assigned. A
`var` field does not narrow under either.

This depends on the clause always running. A clause that a build can
leave out (see [Kinds of clause](#kinds-of-clause)) must not narrow.

### What a postcondition knows

The checker narrows types along the paths of a body: after
`if (text == null) { return 0; }`, `text` is a `String`. A
postcondition holds on every path out of the body, including the one
that returned while `text` was null, so its condition is checked with
what was known on entry and nothing a path of the body narrowed.

What was known on entry includes what the preconditions narrowed on
parameters: a parameter cannot be reassigned, so after
`requires (a is Cat)`, `ensures (result == a.meow())` is accepted. A
narrowing on a member path is left out, because the path can start at a
variable the body assigns.

Without a precondition, nothing is narrowed:

```zena
function length(text: String | null): i32
  ensures (result == text.length)   // Error: text may be null
{
  if (text == null) { return 0; }
  return text.length;
}
```

The condition's own tests narrow as usual:
`ensures (text == null || result == text.length)` is accepted.

### Where clauses are not supported yet

The checker reports each of these:

- Any clause on a method without a body: an interface method, or an
  `abstract` or `declare` method (#929).
- An `ensures` clause on a function whose return type is an inline
  record, or a union that mixes an inline tuple with another member
  (#932). An inline tuple result is bound as the lanes it is returned
  in; these have no such binding yet. `old` of an inline value is not
  supported either: the value is kept from entry as one value.
- An `ensures` clause on an extension class's constructor (#933).
- `old` in a constructor's `ensures` condition (#934).

What the first would mean is under [Open questions](#open-questions).

Two things a function with `ensures` clauses cannot do are rules and
not gaps:

- `tail return`: a tail call discards the frame the postconditions
  would run in.
- In an `async` function, return a future for its caller to wait on in
  place of a value. `result` is the value the future completes with,
  which a future that is handed on has not produced yet. The function
  can `await` it.

## Running a clause

### The check

A clause compiles to its condition, a branch, and on the false side a
call to `$contractFailed` in `zena:core` with a message:

```zena
export function $contractFailed(message: String): never {
  throw new ContractError(message);
}
```

`ContractError` extends `Error` and is in the prelude. The message is
the clause as written followed by "does not hold":
`requires (amount > 0) does not hold`. It carries no file or line; the
error's stack trace has those where the host provides one.

The compiler emits only the call, so what a violated contract does is
that one function's body. A check costs the function it sits in a
branch and a call, and the message is one string constant per clause. A
program without clauses pays nothing: reachability roots
`$contractFailed` and registers a message when it walks a clause
(`noteContractClause`), and not otherwise.

### Preconditions

A function's `requires` clauses run in order at the start of each call,
after the parameters are bound and before anything else the function
does. The first that fails ends the call.

- **Closures.** The conditions run in the closure's frame, so a
  variable they name from the enclosing function is captured, whether
  or not the body mentions it (`analyzeCaptures`).
- **Constructors.** The clauses run before the field initializers, the
  initializer list and the `super(...)` arguments. Constructing a
  subclass runs its own preconditions, then its initializers, then the
  superclass's preconditions. A class's constructor is compiled as a
  factory, used by `new`, and as phases a subclass's factory calls; the
  checks are in the factory and in the first phase, so each
  construction runs them once.
- **`async` functions.** The clauses run when the function is called,
  in the part of the body before its first `await`. A failure completes
  the returned future with the error, as a `throw` there does.
- **Generators.** A generator's body does not start at the call, which
  only makes the iterator. It starts at the first step, and the
  preconditions run then, as the first thing the body does. A call
  with arguments that break a precondition returns an iterator, and
  the first `next()`, or the `for`-in that drives it, throws. This
  holds for an `async gen` function too.

  A precondition is the caller's to keep, so reporting it at the call
  would be better. It needs the check in the function the call
  reaches, which allocates the frame and returns, and that function
  is built by the generator split with none of the body's code in it.

### Loop invariants

A loop's `invariant` clauses run at the loop's header, ahead of its
condition: before the first iteration, after each one, and after a
`continue`. A `for` loop's update runs before them. A `for`-in loop
has three compiled forms, over a range, over an array by index, and
through an iterator, and each checks at its header, before it takes the
next element.

### Postconditions

A function's `ensures` clauses run in order each time it returns, after
the returned value is computed and after any `finally` block the return
passes through. A thrown error is not a return, so
the clauses do not run for it. A clause that fails throws from outside
the function's own `try` blocks, so the function's handlers do not
catch it.

A function returns from many places: `return` statements, the value at
the end of a block body, an arrow's expression body, and the replay of
a return that a `finally` held back. All of them emit their return
through the ZIR builder, so the builder is where they are gathered:
while a function with `ensures` clauses is lowered, a return becomes a
branch to one block whose parameters are the returned values
(`IrBuilder.redirectReturns`). After the body, that block gets the
checks, with `result` bound to its parameter, and then the return
itself. A function that never returns normally gets no block.

`old(e)` is evaluated on entry, after the preconditions. The entry
block comes before every other block on any path, so the value is
simply kept and read at the return. For a reference this keeps the
object, whose fields the body may have changed by then: `old(this.items)`
is the same array, and `old(this.items.length)` is the earlier length.

- **Constructors.** A constructor's `ensures` run after its body, with
  the object as `this`. When the class is a superclass, they run after
  its body and before the subclass's. A constructor with an empty body
  and postconditions is compiled with a body phase to hold them.
- **`async` functions and generators.** Both are lowered as ordinary
  control flow, with plain returns, and split into a state machine
  afterwards, so the same redirect serves them. What a return carries
  there differs: in an `async` function, the value its future
  completes with, which is `result`; in a generator, nothing.
  - An `async` function's postconditions run when its body returns,
    just before its future completes. A failure completes the future
    with the error.
  - A generator's run when its body returns, which is when the
    iteration ends: the step that would report the end throws. A loop
    that leaves early disposes the generator without returning from
    its body, so nothing is checked.
  - `old(e)` is evaluated where the preconditions run: at the call
    for an `async` function, at the first step for a generator. The
    value is live across the suspensions in between, and the split
    keeps it in the frame like any other.
- **Results kept whole.** One optimization returns a record's fields as
  separate values when every caller only reads the fields. A function
  with postconditions is left out of it, because `result` is the
  record.
- **Inline tuple results.** An `inline (i32, i32)` result is returned
  as two values, and the postcondition block takes two parameters.
  `result` is bound to them the way an `inline` parameter is bound to
  its lanes (`inlineBindings`, with the layout `inlineLayoutOf` gives
  the return type), so `result[0]` reads a lane and nothing is boxed.

## Kinds of clause

Three things could be meant by "a kind of condition": one that always
runs, one that runs only in tests, and one that is proved statically.

**An unmarked clause is checked every time, in every build.** This
matches checked casts and bounds checks: a condition the author wrote
is enforced.

**A clause too expensive to run in production is marked `debug`.** A
precondition such as `isSorted(items)` on a binary search costs more
than the function it guards. Only the author knows that, so it cannot
be left to a build flag, which could only turn every clause on or off
together. The marker is a modifier in front of the keyword, in the
style of `tail return`, on any of the three kinds:

```zena
function search(items: FixedArray<i32>, target: i32): i32
  requires (items.length > 0)
  debug requires (isSorted(items))
  debug ensures (result < items.length)
{
  while (lo < hi) debug invariant (isSorted(items)) { ... }
}
```

`debug` is contextual, like the clause keywords: it is the modifier only
directly in front of one of them.

- **Which builds check it.** A test build and a debug build: `zena
test`, and `zena -g build` or `zena -g run`. Every other build leaves
  it out. The compile cache already keys on both.
- **What leaving it out means.** Nothing is emitted for the clause: no
  condition, no call, no message. Reachability and lowering ask the same
  question (`WasmModule.runsContractClause`), so a function the
  condition alone calls is not reached either.
- **Checking.** A `debug` clause is type-checked in every build, by the
  same rules, so it cannot rot in the builds that leave it out. This is
  also why a condition cannot assign or `await`.
- **Narrowing.** A `debug requires` narrows nothing. An unmarked one
  narrows because it always runs; code after a `debug` one may run
  without the check, so it cannot rely on it.
- **The message** is the clause as written, with the modifier:
  `debug requires (isSorted(items)) does not hold`.

The word was chosen for the `--debug` flag that turns it on. `test` and
`audit` were the alternatives (#935).

**Static verification is a second way to discharge the same clauses,
and needs no syntax on the clause.** Ada and SPARK work this way: `Pre`
and `Post` are checked at run time by an Ada compiler and proved by
SPARK, with the same text. The opt-in belongs to the function or the
library, as `@verify` in formal-verification.md. A clause the verifier
proves needs no check at run time, except that a proved `requires`
still has to be checked for callers the verifier did not see.

**A clause that is never checked at run time is marked `static`.**
Verification will bring conditions that cannot run at all, such as a
quantifier over every `i32` or a call to a specification-only function,
and conditions that could run but are meant to be proved. Both take
the marker, in the position `debug` takes:

```zena
function search(items: FixedArray<i32>, target: i32): i32
  requires (items.length > 0)
  static requires (isSorted(items))
  static ensures (result < 0 || items[result] == target)
{ ... }
```

- **Checking.** A `static` clause is type-checked in every build by the
  rules every clause follows: its names resolve, its condition is a
  boolean, `result` and `old` mean what they mean elsewhere. Until a
  verifier exists it is a specification the compiler keeps honest about
  names and types, which is what makes it worth writing down now.
- **Emission.** Nothing, in any build. Reachability and lowering both
  ask `WasmModule.runsContractClause`, which answers false for it.
- **Narrowing.** None, for the reason a `debug` clause narrows nothing.
- **What it may contain.** Today, any expression a clause may contain.
  Quantifiers and specification-only functions arrive with the
  verifier, and are the reason the marker exists before it does.
- **The word.** `static_assert` is the precedent for `static` meaning
  "at compile time". The position, directly before a clause keyword,
  keeps it apart from a member's `static`, and the parser reads it
  there by token kind. `ghost` is Dafny's word and formal-verification.md
  used it; `prove` reads as a command, and nothing proves the clause
  yet; `spec` was the runner-up (#936).
- **One modifier per clause.** `static debug requires` is not a clause
  and does not parse. A `static` clause is left out of every build, so
  `debug` would add nothing to it.

## Alternatives considered

### Conditions without parentheses

formal-verification.md first wrote clauses as `requires amount > 0`,
the form Dafny uses. That form does not depend on line breaks: the next
keyword ends the condition. It has two other problems in Zena.

On an arrow function it is ambiguous. The parser decides that `(`
starts an arrow function by finding `=>` after the matching `)`
(`#isArrowFunction` in `parser.zena`). In

```zena
let pick = (a: boolean, b: boolean, c: boolean) requires a && (b || c) => a;
```

the parser would take `(b || c) => a` for an arrow function and then
reject `b || c` as its parameter list. `requires (a) => a` would parse,
as a condition that is itself an arrow function.

On a declaration, a method and a loop, the condition would be followed
directly by the `{` of the body. No Zena expression continues with `{`
today, so this would parse, but it would rule out any later syntax
where one does, such as `Point {x: 1}`. Rust has that restriction on
the condition of an `if`.

Parentheses are also what `if`, `while` and `match` use, and what the
two other C-family languages with contracts in this position chose: D
writes `in (c)` and `out (r; c)`, and C++26 writes `pre (c)` and
`post (r: c)`. They leave room inside for more than the condition
later, such as a message.

### Decorators

`@requires(amount > 0)` in front of the function would name parameters
before they are declared, and an arrow function, being an expression,
has no place for a decorator.

### Statements at the start of the body

`requires amount > 0;` as the first statements of the body would need
no new position in the grammar. An interface method, an abstract method
and an arrow function with an expression body have no block to put them
in, and a contract is part of what a caller reads, which is the
signature.

### A name for the result

D and C++26 let the author name the returned value (`out (r; r > 0)`).
The implicit `result` is shorter, is what Eiffel, JML and SPARK do, and
conflicts only with a parameter of that name, which the checker
reports.

### Reserved words

Reserving the three words would let a loop with clauses take any
statement as its body. It would also take `requires`, `ensures` and
`invariant` away as names, and `invariant` is one the compiler's own
loop optimizer uses.

## Open questions

- **Throw or trap.** A violation throws a `ContractError`, which a
  caller can catch and a test can assert on, and whose message names
  the clause. A trap would be cheaper and could not be caught. Changing
  it means changing the body of `$contractFailed`.
- **Inheritance.** A method that overrides another, or implements an
  interface method, takes on its contracts. Whether it may add
  `requires` clauses of its own, which would break callers that hold
  the supertype, is open. Until it is decided, a method without a body
  cannot have clauses.
- **A generator's preconditions at the call.** They run at the first
  step today (see [Preconditions](#preconditions)). Running them at the
  call means lowering them into the generator's ramp.
- **A condition on each value a generator yields.** A generator's
  `ensures` is about its body returning. A condition every yielded
  value satisfies would need a clause of its own.
- **Calls with effects in a condition.** Assignments and `await` are
  rejected. A function the condition calls can still change state.
- **Narrowing from `invariant`.** An invariant that held at the test
  could narrow in the loop's body until the body assigns what it
  names. It does not today.
- **A deep `old`.** `old(e)` keeps a reference, so a postcondition
  about the earlier contents of a collection has to copy them itself.
