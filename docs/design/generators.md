# Generators

Status: **Proposed**

This document designs synchronous generator functions for Zena, implemented
**in the self-hosted compiler only**, on top of the ZIR backend
([ir.md](ir.md)). Generators are the first milestone of the long-term
concurrency plan ([concurrency.md](concurrency.md)): they exercise the
suspension-point transform — the machinery that CPS-transforms a function
body into a resumable state machine — without requiring an event loop, a
`Future` type, WASI P3, or JSPI. Everything the transform learns here
(suspension points, liveness across suspends, frame synthesis, resume
dispatch) is reused verbatim when `async`/`await` lands.

A second, equal-priority goal is **performance**: a generator consumed by a
`for-in` loop must compile to the same code as the hand-written loop —
no iterator object, no calls, no allocation. `for (let i in range(0, 5))`
with `range` a generator is the canary benchmark.

## 1. Scope and constraints

- **Sync only.** A generator suspends to its _consumer_ (whoever calls
  `next()`), never to a scheduler. There is no `await`, no `Future`, no
  event loop in this design.
- **Self-hosted compiler only.** The TypeScript bootstrap compiler never
  learns generators. Divergence is managed with the existing
  `// @skip: bootstrap` portable-test directive (~17 precedents, e.g.
  `tests/language/execution/functions/union_callee_dispatch.zena`). This is
  a deliberate forcing function for retiring the bootstrap compiler
  (PLAN.md Phase 1).
- **ZIR only.** Generators are compiled exclusively by the ZIR backend.
  There is no streaming-`FunctionGenerator` implementation, and a ZIR
  lowering bail inside a generator body is a **hard compile error**, not a
  fallback (per the no-fuzzy-fallback rule). Consumers of generator
  _objects_ are unaffected: the split form (§5) is an ordinary class with an
  ordinary method, callable from streaming-compiled code through the
  existing `Iterator` interface path.
- **Two important corollaries of the divergence:**
  1. The compiler's own source (`packages/zena-compiler/zena/`) cannot use
     generators until the bootstrap compiler is deleted — stage1 is built by
     the bootstrap, which cannot parse them.
  2. The stdlib cannot use generators either (the bootstrap compiles stdlib
     for its own test suite). So `range()` does not ship in the stdlib yet;
     the benchmark defines it locally in a self-hosted-only test file.
     Stdlib adoption is a fast follow after bootstrap retirement.

## 2. Surface language

### 2.1 Syntax

A generator is a function expression with the `gen` modifier. `yield` is a
statement (v1) valid only in the immediately enclosing `gen` body:

```zena
let range = gen (start: i32, end: i32): Iterator<i32> => {
  var i = start;
  while (i < end) {
    yield i;
    i += 1;
  }
};

for (let i in range(0, 5)) {
  console.log(i.toString());
}
```

`gen` also applies to methods (modifier position, like `static` —
resolving §10.1):

```zena
class Tree {
  // ...
  gen values(): Iterator<i32> { ... yield node.value; ... }
}
```

New keywords, reserved in the self-hosted tokenizer only: `gen`, `yield`.
A repo-wide grep found zero uses of either as an identifier in Zena source,
so reservation is non-breaking. (`await` and `async` should be reserved at
the same time — one tokenizer divergence, not two.)

### 2.2 Typing

The declared return type of a `gen` function is the **full
`Iterator<T>` type** — the call expression's type, exactly as
annotations mean everywhere else. The yield type is its argument:

```zena
let range: (start: i32, end: i32) => Iterator<i32> =
    gen (start: i32, end: i32): Iterator<i32> => { ... };
```

(This resolves §10.2 the honest-annotation way — an earlier draft made
the annotation the unwrapped yield type, with the modifier implying
the wrapper. That convention belongs to keyword-languages like
Swift/Kotlin, where the declared type IS what a call gives you in
context; in Zena nothing implicitly unwraps `range(0, 5)`, so the
annotation would lie about the call's type. TS/Python/C# — the
type-annotated languages — all spell the wrapper for the same reason,
and it is what TS muscle memory writes. `Iterator` resolves from the
prelude without an import. Consequence for concurrency.md: `async`
annotations spell `Future<Response>` for the same reason.)

Checker rules:

- The annotation, when present, must be `Iterator<T>` (anything else is
  an error naming the rule). With no annotation, the yield type is
  inferred as the union/LUB of all `yield` operands (same machinery as
  return-type inference) and the function types as `Iterator<inferred>`.
- `yield e;` — `e` must be assignable to the yield type `T`.
- `return;` (bare) and falling off the end complete the generator. Value
  returns are **rejected** (§3.1 — the protocol has no completion payload).
- `yield` inside a non-`gen` closure nested in a `gen` body is an error
  (the closure is its own function; it cannot suspend its lexical parent).
  Same rule JS has, and the same rule `await` will have.
- **v1 restriction: `yield` may not appear inside `try`** (either block).
  §6 explains why (early-termination cleanup is a protocol question we
  refuse to answer prematurely). Diagnostic, not a silent limitation.
- `break`/`continue`/`return` inside the generator behave normally (they
  are local control flow of the generator body).

### 2.3 No function coloring

A key property of _sync_ generators: **`gen` is not a color.** The caller
of `range(0, 5)` sees an ordinary function returning `Iterator<i32>`. The
value can be passed anywhere an `Iterator<i32>` goes; `gen` affects only
how the body is compiled. Higher-order code is oblivious. (Contrast
`async`, which changes the call protocol for every transitive caller —
§8.3 discusses what we plan to do about that.)

### 2.4 What a call produces

Calling a generator function runs **none** of the body (JS semantics: lazy
until first `next()`). It returns a fresh single-use iterator; calling the
function again returns an independent one. The static type is
`Iterator<T>` — the existing stdlib interface, unmodified:

```zena
// packages/stdlib/zena/iterator.zena:16 (existing, unchanged)
export interface Iterator<T> {
  next(): inline (true, T) | inline (false, _);
}
```

`for-in` already consumes values that implement `Iterator` directly
(checker `checker.zena:4631`, ZIR path `codegen/ir/control-flow.zena:744`),
so generators need **zero consumer-side changes** to work everywhere
iterators work today.

## 3. How much of the JS generator API do we take?

JS `Generator<Yield, Return, Next>` carries five capabilities. We take one
and a half of them.

| JS capability                                            | Zena v1                                    | Rationale                                                                        |
| -------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `next()` → `{value, done}` (pull)                        | ✅ as `inline (true, T) \| (false, _)`     | The iteration protocol; already exists.                                          |
| Generator is itself iterable                             | ✅ (trivially — for-in accepts `Iterator`) |                                                                                  |
| `next(v)` — send values in                               | ❌                                         | §3.2                                                                             |
| `return(v)` / early termination cleanup                  | ❌                                         | §6 — follows from no-yield-in-try                                                |
| `throw(e)` — inject exception                            | ❌                                         | Only exists to support the async-via-generators polyfill; Zena gets native async |
| Completion value (`return v` → `{done: true, value: v}`) | ❌                                         | §3.1                                                                             |

### 3.1 No completion value

JS generators can `return v`, delivered as `{value: v, done: true}` — and
then `for-of` silently discards it. It exists for coroutine drivers
(`co`, redux-saga), i.e. for the async polyfill role. Zena's protocol
result `inline (false, _)` deliberately has no payload slot, and adding
one would tax every iterator in the language for a feature its main
consumer ignores. A generator that wants to report a summary can expose it
another way (a field on a wrapping object, an out-parameter object, or
just not being a generator).

### 3.2 No send channel — and why it doesn't fit the iteration protocol

The user-facing question: do we need `it.next(v)` resuming `let x = yield e`
with `x = v`?

**The send channel and the iteration protocol are structurally at odds:**

- `for-in` never sends anything. A protocol with a send slot makes every
  ordinary iterator carry a parameter it ignores — and typed, it forces
  `Iterator<T>` to become `Iterator<T, TNext>` with `TNext = void`
  virtually everywhere, infecting every `implements Iterator` in the
  stdlib and user code.
- The first `next()` call has no `yield` to deliver to — JS resolves this
  with the famous wart that the first `next(v)`'s argument is silently
  discarded. Any typed version of that rule is ugly (the first send is
  `void`, subsequent sends are `TNext`? — not expressible in a single
  method signature).
- Two-way generators are coroutines, and their consumers are drivers, not
  loops. If Zena ever wants first-class coroutines, they deserve their own
  type (`Coroutine<In, Out>`) with a `resume(v: In)` method — _not_ a
  widening of `Iterator<T>`.

**Why JS needed it and we don't:** the send channel's killer app was
implementing async/await _in userland_ before the language had it
(generators + a driver that pumps promises back in). Zena's async will be
a native compiler transform sharing this design's machinery (§8) — we
never need the polyfill.

**What we keep anyway:** the _internal_ resume ABI is designed with a
value slot from day one (§5.3), because resuming with a value is exactly
what `await` is (`let x = await f()` resumes the state machine with the
result). Generators simply always pass unit. The language surface stays
one-way; the transform is two-way-ready. If a real coroutine use case
shows up later, the split pass already supports it and only surface
syntax + a `Coroutine` type are missing.

## 4. Compilation overview

Two forms, one source of truth:

1. **Presplit form** — the generator body lowered to ordinary ZIR with
   explicit `yield` suspension terminators. This is what optimization and
   fusion (§7) operate on. It is never emitted as wasm.
2. **Split form** (the state machine) — a synthesized frame class
   implementing `Iterator<T>`, produced from the presplit body by the
   **split pass** (§5), only for generators that are actually consumed as
   iterator objects.

This mirrors ir.md's governing principle (_"discovery decides existence;
layout assigns numbers post-fixpoint"_): **lowering keeps suspension
symbolic; the state machine — frame layout, state numbering, `next()` —
is materialized late, and only for generators that survive as reified
iterators.** A generator that gets fused into every consumer never
becomes a class at all.

LLVM's coroutine pipeline (CoroSplit/CoroElide) validates the shape:
keep the coroutine whole while optimizing and inlining, elide frames that
don't escape, split late for the survivors. C#, Kotlin, and Rust all
split in their IR, not their AST — control-flow splitting on an AST is
exactly the misery ZIR was built to avoid.

### 4.1 ZIR additions

One new terminator:

```
yield %v -> b_resume
```

- Terminates a block; single successor `b_resume` (the resume point).
- `%v` is the yielded value (type = the generator's yield type).
- In v1, `b_resume` takes no parameter derived from the yield. The design
  point for async: a suspension terminator's resume block may declare one
  parameter — the resume value (§5.3). Generators pass unit; `await`
  passes the awaited result. Same terminator family, different wrapper
  protocol.

Pass discipline (enforced by the verifier):

- `yield` appears only in bodies flagged _presplit generator_.
- `yield` is a full effect barrier: never DCE'd, never reordered across,
  GVN value tables are invalidated across it (same treatment as a call
  that may touch anything — conservative and correct; the frame spill in
  §5.2 makes anything cleverer pointless anyway).
- The generic inliner (M3) must not inline a presplit body into a
  non-generator caller — only the fusion pass (§7) may splice presplit
  bodies, because only it knows how to rewrite `yield`.

### 4.2 Pipeline placement

Lowering happens in two phases inside the existing per-module flow
(`module-generator.zena`):

1. **Lower all reached generator bodies** to presplit ZIR, memoized.
   Ordered bottom-up over the generator→generator call graph so that
   for-in loops _inside_ generator bodies can themselves fuse (§7);
   cycles (mutually recursive generators) simply don't fuse at the
   cycle-closing edge.
2. **Lower everything else.** `lowerForIn` gains a fusion fast path
   (§7) consulting the memoized presplit bodies. All other references to
   a generator produce a call to its **ramp function** (§5.1).
3. After lowering (and GVN, today; the M3 loop, later), the **split
   pass** runs once per generator that still has a live ramp reference,
   producing the frame class and `next()`. Then emission as usual.

## 5. The split pass (protocol form)

Input: a presplit body with suspension terminators. Output: three
artifacts, all ordinary — nothing downstream (emission, streaming-compiled
consumers, RTA'd vtables) knows generators exist.

### 5.1 The frame class and the ramp

Per generator function `g`, synthesize a hidden final class:

```
class g$Frame implements Iterator<T> {   // conceptual; synthesized in codegen
  var #state: i32;
  // one field per param used after any suspension point
  // one field per value live across any suspension point
  next(): inline (true, T) | inline (false, _) { <state machine> }
}
```

The original function becomes the **ramp**: allocate the frame, store the
captured params, `#state = START`, return. The ramp is tiny and inlinable
post-split. Its declared return type is `Iterator<T>`; its concrete result
type is `g$Frame` — so once M3 inlining makes an allocation site visible
to a consumer, ir.md §5's exact-type devirtualization trigger fires and
`next()` calls become direct without any generator-specific logic.

Synthesis precedent: closure environment structs are already created
on-demand during function generation (`getClosureKey` / context structs,
`lowering.zena:5441`), and per-(class, interface) vtables on demand via
`getClassInterfaceVTable` (`wasm-module.zena:713`). The frame class uses
the same machinery: a `WasmStruct` + an `Iterator<T>` vtable global,
created when the split pass runs. The checker's existing for-in interface
adaptation (`checker.zena:4631`) needs to know a `gen` call result adapts
to `Iterator<T>`, which falls out of typing the call as `Iterator<T>`.

Frame fields holding non-null references must be declared nullable for
now — frames are allocated with `struct.new_default` before any live
value exists. This is the same nullable-field situation every class field
is in pre-M4 (ir.md §12.1); when single-shot construction lands for
classes, frames still need defaultable slots (they are genuinely
late-initialized), so frames keep nullable fields + resume-side
re-asserts. SRoA'd/fused generators never materialize the frame, so the
hot path doesn't pay this.

### 5.2 The state machine

States: `START`, one `SUSPENDED_k` per yield site, `RUNNING`, `DONE`.

`next()`:

1. Load `#state`; `br_table` dispatch.
2. `START` → jump to the body entry. `SUSPENDED_k` → reload the values
   live at yield `k` from frame fields, jump to `b_resume(k)`.
3. **On entry, store `#state = RUNNING`** before executing body code.
4. At each `yield %v`: store live values to frame fields, store
   `#state = SUSPENDED_k`, return `(true, %v)`.
5. At `return` / body end: store `#state = DONE`, return `(false, _)`.
6. Dispatch on `DONE` → return `(false, _)` (terminated iterators stay
   politely exhausted, matching every stdlib iterator).
7. Dispatch on `RUNNING` → **throw** (`Error("generator is running or
failed")`).

The `RUNNING` poison state buys two loud failures for one store per
resume:

- **Reentrancy** (the generator's body transitively calls its own
  `next()`): JS throws `TypeError` here; we match, rather than silently
  returning `(false, _)`.
- **Resume after throw**: if the body throws, the exception propagates
  out of `next()` and `#state` is left at `RUNNING`; a later `next()`
  throws instead of pretending the iterator finished cleanly. This
  diverges from JS (which marks the generator done) in the loud
  direction — consistent with the no-fuzzy-fallback rule, and irrelevant
  to `for-in` (the throw already terminated the loop).

Liveness is computed on the settled presplit CFG (standard per-block
liveness; values live across any `yield` — including loop-carried block
parameters — get frame fields; everything else stays in wasm locals).
Running the split after the optimization loop means optimization shrinks
frames for free: a value GVN'd or DCE'd away never gets a field.

### 5.3 The resume-value slot (async forward-compatibility)

The split pass is written against a suspension descriptor, not against
`yield` specifically:

```
suspend: value-out %v, resume-block b_r, resume-value none | (type)
```

For generators: `resume-value none`, wrapper = `next()` returning the
protocol tuple. For async later: `resume-value (type of await result)`,
wrapper = the WASI P3 callback ABI / JSPI driver from concurrency.md, with
the resume value flowing in as `b_r`'s block parameter. The state
dispatch, liveness, frame synthesis, and spill/reload logic are identical.
This is the concrete sense in which generators "flush out the transform"
(§8.1 inventories exactly what they do and don't).

## 6. Exceptions, `try`, and early termination

Throwing **out** of a generator works (§5.2: propagates from `next()`,
poisons the frame). Yielding **inside** a `try` is rejected in v1:

```zena
gen (): i32 => {
  try {
    yield 1;        // error: cannot yield inside try (v1)
  } catch (e) { ... }
}
```

Rationale — this is a protocol question wearing a syntax costume:

- If a consumer abandons a suspended generator (`break` out of `for-in`),
  a pending `finally` around the yield can only run if the protocol has a
  termination signal — JS's `it.return()`, called implicitly by `for-of`
  on early exit. That drags in: a second protocol method on `Iterator`
  (taxing every iterator), a defined behavior for yield-inside-finally,
  and "generator finalization" semantics we'd be inventing under time
  pressure. C# forbids `yield` in `catch` and in `try`-with-`catch` for
  cousin reasons; we start stricter.
- ZIR's exception regions (`try_br`, `emit.zena:822`) require properly
  nested handler regions; a suspension edge leaving a handled region and
  re-entering it from `next()`'s dispatch is exactly the kind of region
  surgery ir.md §15 already flags as a risk for plain inlining.
- The restriction is loud, local, and removable. When cancellation is
  designed for async (which faces the same question as "what happens to
  a pending `finally` when a task is cancelled"), generators adopt the
  same answer, and this restriction is lifted in one place.

Consequence: **no `return()` / disposal protocol in v1**, and `for-in`
over generators needs no early-exit hook — `break` just drops the frame
(or, fused, is a plain branch).

## 7. The fast path: for-in fusion

The performance requirement: `for (let i in range(0, 5))` compiles to the
hand-written loop. Two strategies exist; we do both, in order of
reliability.

### 7.1 Strategy A (v1): direct fusion in `lowerForIn`

`lowerForIn` already pattern-matches its iterable and picks fast paths
(FixedArray/Array index loops and the interface fallback,
`codegen/ir/control-flow.zena:869` and `:744`). Fusion is one more arm:
**when the iterable expression is a
direct call to a known `gen` function**, splice the memoized presplit
body instead of materializing anything:

1. Clone the presplit body into the consumer (block splice +
   `refTable`/`typeTable` merge — the same mechanics ir.md §9 specifies
   for the M3 inliner; fusion is deliberately its first client, so the
   splice machinery gets built once).
2. Bind generator params to the evaluated call arguments.
3. Rewrite each `yield %v -> b_r` into a **clone of the loop body** with
   the loop variable bound to `%v`; the body clone's normal exit branches
   to `b_r`; `break` branches to the loop exit; `continue` branches to
   `b_r`.
4. Rewrite generator `return`/body-end to branch to the loop exit.

No frame, no calls, no state — the yield _is_ the loop body. For `range`
(one yield site) the result is, after GVN, CFG-identical to the
hand-written `while` loop; that identity (or near-identity of emitted
bytes) is the G2 acceptance test.

Code growth is `(#yield sites) × (loop body size)`, bounded by a fusion
budget; over budget → fall back to the protocol form (correct, just not
free). Single-yield generators — the overwhelmingly common shape — always
fit.

Why lowering-time and syntactic, rather than trusting the optimizer:
**the perf model must be predictable.** "A generator in a for-in header
is free" is a rule a user can hold; "free if escape analysis and three
other passes align" is not. This also makes the fast path independent of
M3 — it works at `-O0`, today's pipeline.

What Strategy A misses, by design: iterators that pass through a variable
(`let it = range(0, 5); for (let i in it)`), through helper returns, or
through interface-typed parameters. Those take the protocol form and are
the optimizer's job:

### 7.2 Strategy B (M3): fusion and elision inside the fixpoint loop

Once the M3 loop exists (inline ⇄ devirt ⇄ SRoA ⇄ SCCP ⇄ DCE):

- **Fusion as a loop pass.** Re-run the §7.1 pattern match inside the
  fixpoint: when inlining turns `for (let x in makeThings())` into a loop
  whose iterable is (now visibly) a direct generator call, fuse then.
  This is what makes **pipelines** collapse: with `map`/`filter` written
  as generators over generators, inlining `map` exposes
  `for (let y in range(...))` inside it, which fuses; another round fuses
  the consumer. Stream fusion falls out of inline+fuse iterating to
  fixpoint, with no dedicated deforestation machinery.
- **Frame elision for the rest.** Protocol-form generators whose ramp got
  inlined expose `struct.new g$Frame` locally; exact-type devirt turns
  `next()` calls direct; inlining `next()` puts the `br_table` in the
  consumer; SRoA scalarizes the non-escaping frame (the `#state` field
  becomes an SSA value); SCCP/jump-threading then folds the constant
  state dispatch. This is the LLVM CoroElide analogue and will catch a
  good fraction of the `let it = ...` cases — but it is an optimization,
  not a guarantee, and the last step (threading a loop-carried state
  constant) is the weakest link. We do not gate v1 performance claims on
  it.

### 7.3 Expected cost tiers

| Shape                                      | Cost per element                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `for (let i in range(0, 5))` (fused, v1)   | 0 — identical to hand loop                                                                            |
| Protocol form, post-M3, frame non-escaping | ~0 after elision (best-effort)                                                                        |
| Protocol form, devirtualized (M3)          | 1 direct call + frame field traffic                                                                   |
| Protocol form, `-O0` / escaping            | 1 allocation total; 1 interface dispatch (`call_ref`) per element — same as any stdlib iterator today |

The floor tier is worth stating plainly: an _unoptimized_ Zena generator
costs what a hand-written iterator class costs. There is no
JS-style-generator penalty (reified iterator-result objects, megamorphic
protocol lookups) at any tier, because the protocol result is an unboxed
multi-value and dispatch is a vtable slot.

### 7.4 `yield*` delegation (v1.1)

`yield* e` (exact spelling open, §10) desugars to
`for (let x in e) { yield x; }` — with a one-way protocol, delegation
_is_ iteration, nothing more. Because that desugar is a for-in, fusion
applies: statically-known delegation chains (`yield* leftSubtree()`)
flatten at compile time, avoiding the O(depth)-per-element cost JS
delegation pays at runtime. Dynamic delegation degrades to the protocol
form gracefully. Deferred to v1.1 only to keep the v1 checker surface
minimal; it adds no new transform machinery.

## 8. Relationship to async

### 8.1 What generators do and don't flush out

Flushed out here, reused by async as-is:

- suspension terminators in ZIR + pass discipline around them;
- liveness across suspension points; frame synthesis; spill/reload;
- state dispatch, poison states, resume-block plumbing (with the §5.3
  value slot);
- verifier rules and emission implications (the state machine is plain
  ZIR by emission time — nothing changes in the stackifier);
- the fusion/elision playbook for making suspension free when the
  consumer is local.

Explicitly **not** flushed out (async-only work, per concurrency.md):

- the `Future<T>` type and its checker rules;
- schedulers: the WASI P3 callback ABI (status codes, waitable sets,
  `task.return`) and the JSPI/JS-event-loop driver;
- suspension across `try` (cancellation semantics — §6 punted this in
  both features deliberately, to answer it once);
- structured concurrency, spawn, combinators;
- async ABI questions (what an exported async function looks like).

That is: generators build the _transform_; async adds the _runtime
protocol_ around it. This is exactly the split concurrency.md's Phase 1
("CPS Transform Infrastructure") vs Phases 3–4 (backends) anticipates.

### 8.2 Why `yield` and `await` are (and should stay) separate keywords

The question from the prompt: why does JS have both? Because they suspend
toward **different parties**, and a function can need both at once:

- `yield` suspends toward the **consumer** — control and a value go to
  whoever holds the iterator. The consumer decides when (whether!) to
  resume.
- `await` suspends toward the **scheduler** — control goes to the event
  loop; resumption is automatic when the awaited thing settles. The
  consumer of the _values_ never observes these suspensions.

An **async generator** needs both channels in one body — `await` a fetch,
then `yield` the result to the iterating consumer — so the two operations
cannot share a keyword. (JS's pre-async-generator era hid this: when
generators+driver _were_ the async mechanism, `yield` meant "await" by
convention, which is precisely the ambiguity the separate keyword
resolved.) They also type differently: `yield e` checks `e` against the
yield type and produces (in v1) nothing; `await e` takes `Future<T>` and
produces `T`.

Zena inherits the same layering cleanly:

| Modifier    | Value returned     | Suspends toward | Suspension ops    |
| ----------- | ------------------ | --------------- | ----------------- |
| `gen`       | `Iterator<T>`      | consumer        | `yield`           |
| `async`     | `Future<T>`        | scheduler       | `await`           |
| `async gen` | `AsyncIterator<T>` | both            | `yield` + `await` |

`AsyncIterator<T>` (likely `next(): Future<inline (true, T) | (false, _)>`,
design deferred) answers the prompt's other musing — "async iteration
over a standard iterable that might return Promises": in Zena that's not
a convention layered on sync iterators, it's the third row of the table,
compiled by the same split pass with both suspension kinds live.

### 8.3 Sync/async-polymorphic functions (the Lit SSR problem)

The pattern from Lit SSR: one body that runs synchronously when the
context allows and asynchronously when it must, implemented in JS as
"yield thunks/promises, drive with a context-appropriate driver, throw if
a Promise shows up in a sync context." It works and it's miserable.

Position: **generators are not Zena's answer to function coloring — the
specializer is.** Zena is a whole-program monomorphizing compiler; "color"
can be a specialization axis like a type parameter. A `maybe-async`
function compiles twice:

- a **sync instantiation**, where `await` on an already-resolved value is
  a no-op unwrap and `await` on a genuinely pending operation is a loud
  error ("would block in sync context") — the moral equivalent of the
  SSR driver's throw, but at the exact suspension point, with a stack;
- an **async instantiation**, the ordinary CPS form.

Callers select the instantiation by their own context, transitively —
the compiler does the two-driver dance mechanically instead of the user
doing it manually per call site. Zig demonstrated this is workable
(pre-0.11 inferred-async, colorblind by monomorphization); Koka-style
effect polymorphism is its type-theoretic dress. Whether the polymorphism
is inferred (Zig) or explicit (an effect parameter) is a design fight for
the async doc, _not_ this one — but this design keeps the door open by
ensuring both instantiations come out of the same split machinery, and
nothing in the generator surface (no send channel, no driver protocol)
becomes a load-bearing polyfill idiom that we'd have to support forever.
The type-system half of any such generalization — row unification, lacks
constraints, canonical row identity, monomorphized row instantiation —
is being proven first on records in [row-types.md](row-types.md) §8,
which inventories exactly which machinery a future effect-row system
would inherit.

Meanwhile, the interim expressible version of the SSR pattern — a `gen`
yielding `Thunk | Future<T>` union values with a small driver — still
works in Zena, and fused generators make it cheaper than in JS. It's a
pattern, not a blessed API; we should not ship stdlib support for it.

## 9. Milestones

Independent of, but sequenced against, ir.md's M-track (M2 parity in
progress; M3 loop not started).

- **G0 — front end.** ✅ **Done.** Reserve `gen`/`yield` (+ `async`/`await`)
  in the self-hosted tokenizer; parse `gen` functions/methods and `yield`
  statements; AST + checker (yield typing, `Iterator<T>` wrapping,
  yield-in-try and yield-in-closure rejections, lazy-call semantics).
  Portable syntax/semantics tests with `// @skip: bootstrap`.
  _No dependency on ZIR work; can start immediately._
- **G1 — split pass (protocol form).** ✅ **Done**
  (`codegen/ir/generators.zena`). `yield_` terminator in
  `codegen/ir/ir.zena`; presplit lowering of `gen` bodies (ZIR-only,
  hard-error on bail); split pass — frame struct from suspension
  liveness, `next()` synthesis as a dispatcher-loop state machine
  (reducible by construction; `br_if` chain until `br_table` gains
  emit support), `RUNNING`/`DONE` semantics; execution tests through
  the existing for-in `Iterator` path and manual
  `while (let (true, x) = it.next())` consumption.
  _Implementation notes vs. this section: the split runs between RTA
  and `layout()` (today's pipeline locks type/function indices before
  lowering, so nothing can be synthesized "after GVN"); the frame is a
  bare struct with a hand-rolled `Iterator<T>` vtable global rather
  than a ClassType; the RUNNING poison state traps (`unreachable`)
  instead of throwing — a synthesized throw needs an Error payload,
  which would pull Error + string machinery into every program with a
  generator, so it waits for the async runtime work. Generator
  closures (immutable, celled-mutable, and `this` captures) and
  specialized generic generators work; the one unsupported corner is a
  generic gen method reached only through erased vtable dispatch,
  which fails loudly._
- **G2 — fusion.** Presplit body memoization + bottom-up generator
  lowering order; block-splice/clone machinery (built as the shared
  substrate for the M3 inliner); the `#lowerForIn` fusion arm with
  budget + protocol fallback. Acceptance: `zena:bench` benchmark of
  `range`-in-for-in vs hand-written loop shows parity, and the fused
  function's emitted body is call-free and allocation-free.
- **G3 — with/after M3.** Fusion as a fixpoint-loop pass (pipeline
  collapse); frame elision via inline+SRoA+SCCP for protocol-form
  survivors; frame minimization from post-optimization liveness;
  `yield*`; celled-capture generators if still bailing
  (`lowering.zena:5496`).
- **Post-bootstrap.** Stdlib adoption: `range()`, generator-backed
  `Iterable` combinators (`map`/`filter`/`takeWhile` as generators —
  revisiting iterable-methods.md Phase 2 with fusion in hand, which
  changes that document's performance calculus); compiler-internal use.
- **Async (separate design).** Resume-value channel activation, `Future`,
  drivers, `async gen` — per concurrency.md, informed by what G1–G3
  learned.

## 10. Open questions

1. **Method syntax**: ✅ Resolved at G0 — modifier position
   (`gen values(): Iterator<i32>`), symmetric with `static`/`abstract`.
2. **Annotation semantics**: ✅ Resolved at G1 (PR #157 review) —
   declared type = `Iterator<T>`, the call expression's type (§2.2 has
   the reasoning; the unwrapped convention belongs to keyword-languages
   where calls implicitly unwrap, which Zena's `gen` does not).
   `async` follows suit: annotations spell `Future<T>`.
3. **`yield*` spelling**: `yield* e` (JS), `yield in e` (reads like
   for-in), or nothing (let users write the two-line loop).
4. **Reentrancy/poison semantics**: is throwing from `next()` on a
   `RUNNING` frame acceptable divergence from JS's done-after-throw? (This
   doc says yes — loud beats compatible — but it's cheap to revisit.)
5. **Fusion budget**: what's the yield-count × body-size cutoff, and
   should exceeding it warn under a flag (the user asked for a
   guarantee; silently degrading to the protocol form is a quiet perf
   cliff — `ZENA_ZIR_STATS`-style counter at minimum).
6. **Does the checker expose the frame class at all** (e.g. for
   `is`-tests on iterator values)? Proposed: no — the frame class is
   invisible, `Iterator<T>` is the only type. Runtime-type-tag rules
   (runtime-type-tags.md) should be checked against this.
7. **Interaction with template ZIR (M5)**: generic generators
   (`gen <T>(xs: Array<T>): T`) want the presplit body to be the template
   and splitting to happen per-instantiation. Nothing here seems to
   conflict — the split pass runs downstream of specialization — but M5's
   audit list (ir.md §15) should include suspension terminators.
