# Tail Calls

Status: **Proposed**

`tail return f(x);` compiles the call to WebAssembly's `return_call`
(or `return_call_ref`): the current frame is discarded before the callee
runs, so a chain of tail calls executes in constant stack space.

Issue: [#134](https://github.com/elematic/zena/issues/134).

## 1. Why the call is annotated

A compiler that recognises tail positions on its own can eliminate the
frame silently. Zena does not, for two reasons.

**Correctness.** A program written against tail-call elimination breaks
when the optimisation does not fire — a loop that ran in constant space
overflows the stack instead. Whether it fires depends on the shape of
the surrounding code (an enclosing `try`, a `using` binding, a return
type that needs converting), which is not visible at the call site. An
annotation makes the guarantee part of the signature of the statement:
either the call is a tail call or the program does not compile.

**Stack traces.** A tail call erases the caller's frame, and with it the
caller's line in every backtrace and profile taken from inside the
callee. Applying that to every call in tail position would degrade
debugging across the whole program for a property most calls do not
need.

So `tail` is written where the caller wants it, and nowhere else. Calls
in tail position without the annotation compile to an ordinary `call`.

## 2. Syntax

```zena
function fib(n: i32, a: i32 = 0, b: i32 = 1): i32 {
  if (n == 0) {
    return a;
  } else if (n == 1) {
    return b;
  } else {
    tail return fib(n - 1, b, a + b);
  }
}
```

`tail` is a contextual keyword, not a reserved word: it is only special
as the first token of a statement whose next token is `return`. `tail`
stays available as an identifier, which matters — it is the name of half
the linked lists ever written.

There is no `tail` form of anything else. A bare `tail return;` does not
parse; the operand must be a call.

## 3. Rules

`tail return e;` is rejected unless all of the following hold. Each is
reported by the checker, at the `tail return` statement.

1. **`e` is a call.** `f(x)`, `o.m(x)`, `this.#m(x)` — anything the
   compiler emits as one wasm call instruction. Not `f(x) + 1`, not
   `new C(x)`, not an optional call `f?.(x)`.
2. **The enclosing function declares a return type**, and the call's
   type is that same type. The wasm instruction requires the callee's
   results to be assignable to the caller's, and any Zena conversion
   between two different types (packing a class into an interface, for
   one) is code that would have to run *after* the callee returned — the
   frame the tail call just discarded. Requiring the types to match is
   the rule that makes "this compiles" and "this is a tail call" the
   same question.
3. **The enclosing function is not `async` and not a generator.** In
   both, `return` completes a future or an iteration rather than
   returning from the wasm function it was written in, so there is no
   frame in tail position to discard.
4. **The enclosing function is not a constructor.** A constructor body
   is inlined into a factory that returns the new instance; a `return`
   there returns that instance, not the operand.
5. **No enclosing `try` and no live `using` binding.** Both owe work on
   the way out — a `finally`, a `dispose` — and that work runs after the
   callee returns. A `catch` cannot fire for a callee whose caller's
   frame is already gone, either.

Rules 3–5 are about the frame being genuinely dead at the call. Rule 2
is about the call site needing no code after the call. Together they
are what a `return_call` means.

## 4. Compilation

ZIR gains two terminators, `ret_call` and `ret_call_ref`, with the same
operand encodings as `call` and `call_ref` and no result. They emit
`return_call` (0x12) and `return_call_ref` (0x15).

Lowering a tail return lowers the call expression exactly as an ordinary
call — so every callee shape the backend already handles (a direct
function, a monomorphised generic, a non-virtual method, a vtable
dispatch, a closure) is a tail call for free — and then rewrites the
call instruction it produced into the matching terminator. The rewrite
is in place: the operands do not move, the result type is dropped, and
no `ret` is emitted.

The rewrite applies only when the call instruction is the last one
lowered into the current block and the value returned is the call's own
result. That is precisely the condition under which no code runs between
the call and the return, so it is the condition the wasm instruction
needs. When it does not hold — because the call lowered to inline
instructions (an `@intrinsic`), or to several calls (a call through a
union of function types), or because the result needed converting — the
compile fails rather than emitting an ordinary call.

The checker rules in §3 are what keep that failure from being how users
learn the rules; a lowering that reaches it is a compiler bug in the same
way any other ZIR bail is.

`return_call_indirect` has no use here. Zena emits no function tables:
an indirect call is a `call_ref` through a funcref, which
`return_call_ref` covers.

## 5. Runtime support

Tail calls are a finished WebAssembly proposal, shipped in V8 and
Wasmtime. `zena-cli` enables `wasm_tail_call` on its wasmtime `Config`
alongside GC, function references and exceptions.

## 6. Not in this design

- **Inferred tail calls.** §1.
- **Mutual recursion across differing return types.** Rule 2 forbids a
  tail call from a function returning `Animal` to one returning `Dog`,
  though wasm would accept it (callee results need only be subtypes).
  Allowing it means the checker reasoning about which Zena subtype pairs
  survive to wasm subtypes unchanged, and interfaces and unions do not.
  A plain `return` is the workaround.
- **Multi-value tail returns.** A function returning an inline tuple
  lowers its return through `ret_multi` and per-result projections;
  `return_call` supports the shape, the ZIR rewrite does not yet.
- **`tail` on an arrow function's concise body.** `() => tail f(x)` is
  not syntax. Write a block body.
