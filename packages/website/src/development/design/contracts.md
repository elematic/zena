---
title: 'Contracts'
description: 'Design rationale for Zena contracts: parenthesized clauses, contextual keywords, precondition narrowing, ZIR return redirection, test-only checks, and static verification.'
---

Contracts write a function's assumptions and guarantees into its signature and a
loop's inductive assumptions into its header:

```zena
function withdraw(account: Account, amount: i32): Account
  requires (amount > 0)
  requires (account.balance >= amount)
  ensures (result.balance == account.balance - amount)
{
  // ...
}
```

The design serves three roles without changing syntax along the way:
always-on runtime assertions (`requires`, `ensures`, `invariant`), test- and
debug-only checks (`debug`) for expensive predicates, and static verification
with SMT solvers later.

## Runtime checks first, static proofs later

An unmarked contract clause runs on every call in every build, throwing a
`ContractError` when violated. That matches how Zena treats array bounds checks
and `as` downcasts: a safety condition written in source code is enforced at
runtime unless proven redundant.

Starting with runtime execution makes contracts useful immediately—especially in
AI-assisted development, where an agent iterating against `zena test` gets an
exact `ContractError: ensures (result.balance == ...) does not hold` message
instead of a silent wrong answer downstream. At the same time, keeping conditions
free of side effects (forbidding assignments and `await`) keeps the surface ready
for a static verifier to translate the exact same clauses into proof obligations,
following the model of Ada and SPARK.

Where the compiler cannot yet lower a clause—such as on a generator or an
`async` function's postcondition—the type checker rejects it rather than parsing
and ignoring it. A contract written in a program is never silently skipped.

## Parenthesized conditions and contextual keywords

### Why conditions are parenthesized

Languages in the Dafny family write clauses without parentheses:
`requires amount > 0`, terminated by the next clause keyword or `{`. In Zena,
unparenthesized conditions fail in two places:

1. **Arrow function lookahead**: Zena's parser identifies `( ... ) => ...` by
   scanning past the parameter list for `=>`. In an unparenthesized arrow clause:

   ```zena
   let pick = (a: boolean, b: boolean, c: boolean) requires a && (b || c) => a;
   ```

   the parser sees `(b || c) => a`, mistakes `b || c` for an arrow parameter
   list, and fails. Requiring parentheses around the condition gives the
   lookahead a balanced `(...)` delimiter to step over cleanly, just as `if`,
   `while`, and `match` already use, and matches D (`in (c)`) and C++26
   (`pre (c)`).

2. **Future brace expressions**: An unparenthesized clause before a function or
   loop `{` body would prevent Zena from ever adding `TypeName {field: value}`
   expressions inside conditions without introducing Rust-style expression
   restrictions before `{`.

Parentheses also leave clean grammatical room inside the clause for future
additions, such as custom failure messages.

### Why clauses sit in the signature

Putting `requires` at the top of the `{ ... }` body as a statement would avoid
touching function signatures, at the cost of hiding contracts inside the
implementation. Arrow functions with expression bodies have no `{ ... }` block,
and interface or abstract methods have no body at all. Placing contracts between
the signature and the body keeps them part of what callers and tools read.

### Why keywords stay contextual

Reserving `requires`, `ensures`, `invariant`, and `debug` globally would break
ordinary variable names—including `invariant` inside the Zena compiler's own loop
optimizer and `debug` options across CLI and build code.

In signature position, nothing valid starts with an identifier after parameters
or a return type, so `requires`, `ensures`, and `debug` before a clause keyword
are unambiguous there. After a loop header, however, `while (c) invariant(x);` is
already a valid single-statement loop calling a function named `invariant`.
Requiring a `{ ... }` block body on loops with clauses resolves the overlap:
`invariant (...)` or `debug invariant (...)` followed by `{` or another loop
clause is always a contract clause, while `invariant(...);` followed by `;` is
always a call statement.

### Implicit `result`

D and C++26 bind the return value to a user-chosen identifier (`out (r; r > 0)`).
Using the implicit name `result` inside `ensures` scopes (as Eiffel, JML, and
SPARK do) avoids punctuation inside every postcondition and conflicts only when a
function with `ensures` also names a parameter `result`, which the checker
diagnoses directly.

## Narrowing from preconditions

Because an unmarked `requires` clause runs on every entry and throws before the
body executes when `false`, anything its condition proves `true` holds on entry
to the body:

```zena
let trimmedLength = (text: String | null) requires (text != null) => text.trim().length;
```

The checker feeds each `requires` condition through the same flow-narrowing
engine `if` uses, carrying narrowed bindings and immutable member paths into
subsequent clauses and the body.

Postconditions follow a stricter rule. Inside a body, an early guard like
`if (text == null) return 0;` narrows `text` to `String` for the lines after the
`if`. Yet the `ensures` clause also runs on that early return where `text` _was_
`null`. The checker therefore checks `ensures` conditions against entry types
plus parameter narrowings from `requires`, ignoring path-local body narrowings.

## Gathering returns and entry values

### Redirecting returns in ZIR

A function can return from many places during lowering: explicit `return`
statements, the trailing expression of a block or arrow body, and returns held
back while unwinding through `finally` blocks. Rather than duplicating
postcondition checks at each exit site, ZIR's `IrBuilder` redirects all return
emissions (`ret`, `retVoid`, `retMulti`) while lowering a function with `ensures`
clauses into branches targeting a single postcondition block whose parameters
carry the returned value.

After lowering the body (and after any `finally` blocks along the return path),
that postcondition block binds `result`, evaluates every `ensures` clause outside
the function's own `try` handlers, and executes the real return. Because a tail
call (`tail return`) discards the frame before the callee runs, `tail return` is
disallowed on functions with `ensures` clauses.

### Capturing `old(e)`

`old(e)` evaluates `e` in the entry block immediately after preconditions succeed
and stores the SSA value so the postcondition block can read it on exit. Because
the entry block dominates every return path, no extra state flag is needed for
ordinary functions. Reference values are kept by reference rather than cloned;
postconditions inspecting prior collection contents either query scalar snapshots
like `old(this.items.length)` or explicitly copy what they need.

### Zero cost when unused

Each clause lowers to a branch calling `$contractFailed(message)` in `zena:core`.
Reachability analysis roots `$contractFailed` and the clause message string only
when walking a reachable contract clause (`noteContractClause`), so modules
without contracts emit zero extra code or data.

## Debug and ghost clauses

Not every useful contract belongs in a production binary:

1. **Expensive runtime checks (`debug`, implemented)**: A precondition like
   `isSorted(items)` takes $O(n)$ work to guard an $O(\log n)$ binary search. A
   global compiler flag that strips _all_ contracts in release builds is too
   coarse—cheap guards like `amount > 0` should stay on, and only the author of a
   clause knows its algorithmic cost. Zena places the contextual `debug` modifier
   directly on `requires`, `ensures`, or `invariant`:

   ```zena
   function search(items: FixedArray<i32>, target: i32): i32
     requires (items.length > 0)
     debug requires (isSorted(items))
   {
     // ...
   }
   ```

   `debug` clauses compile and run under `zena test` and in builds made with
   `--debug` / `-g` (`zena -g build`, `zena -g run`), matching the CLI flag name
   (chosen over `test` and `audit`). In every other build, both reachability and
   lowering skip the clause (`WasmModule.runsContractClause`), emitting no
   condition, call, message string, or otherwise-unused helper functions. The
   type checker still checks `debug` clauses in every build so they cannot rot,
   and `debug requires` narrows nothing because the body runs without the check
   in ordinary builds.

2. **Static verification and `ghost` clauses (planned)**: When Zena adds opt-in
   SMT verification (`@verify`), ordinary `requires`, `ensures`, and `invariant`
   clauses need no syntax change—proven clauses can elide their runtime checks
   (while retaining boundary checks for unverified callers). Specifications that
   cannot execute at runtime at all, such as quantifiers over unbounded ranges or
   inductive helper lemmas, will use a `ghost` modifier in the same position:

   ```zena
   while (lo < hi)
     invariant (0 <= lo && lo <= hi)
     ghost invariant (forall j :: 0 <= j < lo ==> items[j] < target)
   {
     // ...
   }
   ```

## Open questions and current gaps

- **Contract inheritance on interfaces and overrides**: Methods without bodies
  (`interface`, `abstract`, `declare`) currently reject clauses. Behavioral
  subtyping requires overrides to accept at least what the base contract accepts
  (weakening or keeping preconditions) while guaranteeing at least what the base
  promises (strengthening or keeping postconditions), and the compiler must
  decide whether checks live at dispatch trampolines or inside implementations.
- **Generators**: A generator body does not run until `.next()` is called and
  yields zero or more values rather than returning once. Whether `requires` runs
  at the call site (in the generator ramp) or on first step, and how `ensures`
  describes yielded elements vs. completion, remain open.
- **`ensures` on `async` functions**: Async functions split into state machines
  after ZIR lowering, so propagating `old(e)` values across suspension points and
  running `ensures` when the returned `Future<T>` resolves are still being wired
  up (`requires` already runs in the eager prefix).
- **Constructor `old()` across inheritance**: Class constructors compile into an
  initializer phase and a body phase so subclasses can initialize fields before
  allocation; threading `old(e)` values from entry in `<ctor-init>` to
  postconditions in `<ctor-body>` is tracked separately.
- **Side-effecting helper calls**: Assignments and `await` inside conditions are
  rejected today, while calls to impure functions are not yet restricted until
  purity checking is formalized.

→ Working documents:
[`contracts.md`](https://github.com/elematic/zena/blob/main/docs/design/contracts.md),
[`formal-verification.md`](https://github.com/elematic/zena/blob/main/docs/design/formal-verification.md),
[`ai-first-language.md`](https://github.com/elematic/zena/blob/main/docs/design/ai-first-language.md)
