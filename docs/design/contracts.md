# Contracts

Status: **Syntax and checking implemented; runtime checks not yet**

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

The parser accepts the syntax in this document and the checker applies
the rules under [Checking](#checking). Nothing runs a clause yet, so
code generation refuses a program that has one: a program cannot
contain a contract that is silently ignored.

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
body's own variables do not exist yet.

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
neither has a constructor, whose new object is `this`.

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

The checker reports clauses on a generator, and on a method without a
body (an interface method, or an `abstract` or `declare` method). What
each would mean is under [Open questions](#open-questions).

## Kinds of clause

Three things could be meant by "a kind of condition": one that always
runs, one that runs only in tests, and one that is proved statically.

**An unmarked clause is checked every time, in every build.** This
matches checked casts and bounds checks: a condition the author wrote
is enforced.

**A clause too expensive to run in production needs a marker on the
clause.** A precondition such as `isSorted(items)` on a binary search
costs more than the function it guards. Only the author knows that, so
it cannot be left to a build flag, which could only turn every clause
on or off together. The plan is a modifier in front of the keyword, in
the style of `tail return`:

```zena
debug requires (isSorted(items))
```

A `debug` clause would run under `zena test` and in builds that ask for
it, and be left out otherwise. The word `debug` is a placeholder; the
position of the modifier is the decision.

**Static verification is a second way to discharge the same clauses,
and needs no syntax on the clause.** Ada and SPARK work this way: `Pre`
and `Post` are checked at run time by an Ada compiler and proved by
SPARK, with the same text. The opt-in belongs to the function or the
library, as `@verify` in formal-verification.md. A clause the verifier
proves needs no check at run time, except that a proved `requires`
still has to be checked for callers the verifier did not see.

**Verification will add conditions that cannot run at all**, such as a
quantifier over every `i32` or a call to a specification-only function.
Those need a marker on the clause too, so that the compiler knows never
to emit them. formal-verification.md writes it `ghost invariant (...)`,
and it takes the same position as `debug`.

Neither modifier is parsed yet.

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

These are decided when the lowering is written.

- **What a violation does.** The likely answer is to throw an error
  that names the clause's text and location, as `zena:assert` does for
  a failed assertion. A trap would be cheaper and could not be caught.
- **Inheritance.** A method that overrides another, or implements an
  interface method, takes on its contracts. Whether it may add
  `requires` clauses of its own, which would break callers that hold
  the supertype, is open. Until it is decided, a method without a body
  cannot have clauses.
- **Generators.** A generator's body runs when it is first stepped, and
  it has no single result. A `requires` clause could run at the call or
  at the first step.
- **`async` functions.** `ensures` holds when the future completes. A
  `requires` clause would run in the part of the body before its first
  `await`.
- **Calls with effects in a condition.** Assignments and `await` are
  rejected. A function the condition calls can still change state.
- **Narrowing from `invariant`.** An invariant that held at the test
  could narrow in the loop's body until the body assigns what it
  names. It does not today.
- **Capturing `old`.** `old(e)` has to evaluate `e` on entry and keep
  the value. For a reference this keeps the object, whose fields the
  body can still change.
