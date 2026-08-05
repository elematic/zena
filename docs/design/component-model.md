# Component Model & WIT Bindings

## Status

- **Status**: Proposed — no implementation; open questions marked
  **DECIDE** below
- **Date**: 2026-08-04
- **Supersedes**: the "Strategy" and "Implementation Plan" sketches in
  [wasi.md](./wasi.md), which predate the WIT parser being finished

## What exists today

| Piece                                | State                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| WIT lexer / parser / resolver        | ✅ Done — [wit-parser.md](./wit-parser.md), 211/211 wasm-tools UI tests             |
| WIT → `.wit.json` (wasm-tools shape) | ✅ Done                                                                            |
| Parser callable from the compiler    | ⚠️ Has a public entry point (`wit-parser:wit`) and is in the package map; nothing in the compiler calls it yet |
| WIT → Zena bindings (bindgen)        | ❌ Does not exist                                                                   |
| Canonical ABI lift/lower             | ❌ Does not exist. WASI is used today via hand-written `@external` decls at the      |
|                                      | already-flattened core ABI with manual `i32.store8` pokes (see `wasi_fs_test.ts`)   |
| Component emission                   | ❌ `--target wasi` emits a **core module** with `wasi_snapshot_preview1` imports     |
| `async` / `await` in the language    | ❌ Zero occurrences in either compiler's lexer or parser                             |

So: parsing WIT is solved; **everything that turns a parsed WIT into a running
component is unbuilt**, and this document is the missing design for that.

---

## Part 1: Three things people call "a handle"

The question "how do you get a handle to an interface — do you construct it, or
is it handed to you?" has three different answers, because WIT uses one word
for three unrelated things.

### 1. An *imported interface* — neither. It is **linked**.

A component's world lists interfaces it imports. Those are satisfied at
instantiation time by the host or by a composition tool. From inside the guest
there is no object and no constructor: you cannot allocate one, and you cannot
conjure an extra one at runtime. After canonical lowering an imported interface
is just a set of core wasm imports.

**But "linked" does not mean "one".** A world may import the same interface any
number of times under distinct names, and each one is an independently wired
instance. Verified against `wasm-tools` 1.252.0:

```wit
package test:b;
interface handler { handle: func(x: string) -> string; }

world w {
  import upstream: handler;
  import downstream: handler;
  import handler;          // the unaliased/default one
  export handler;          // import and export the same interface: fine
}
```

That survives the full round trip — `component embed --dummy` → `component new`
→ `component wit` reproduces all three imports — and lowers to three *distinct*
core import modules, which is what a Zena `@external` binds to:

```wat
(import "cm32p2|upstream"        "handle" (func ...))
(import "cm32p2|downstream"      "handle" (func ...))
(import "cm32p2|test:b/handler"  "handle" (func ...))
```

Aliasing works cross-package, and versions namespace independently
(`dep:h/handler@1.0.0` and `dep:h/handler@2.0.0` coexist in one world). So all
three of the obvious mechanisms — **renaming, namespacing, and
instantiation-time wiring** — are real and compose.

The one thing genuinely fixed is the *count and names*: the set of import slots
is frozen in the world at compile time. You choose how many `handler`s you want
and what to call them when you write the world; you cannot ask for an
`n+1`-th at runtime.

> **On the `wasi:http` comment.** `wasi:http@0.3.0-rc-2025-09-16` carries a
> `client` interface duplicating `handler`, explaining that "some Component
> Model tooling (including WIT itself) is unable to represent a component
> importing two instances of the same interface." As of `wasm-tools` 1.252.0
> that is no longer true of WIT or of the binary format — the test above is
> exactly the shape it says is impossible. Treat the comment as stale, or as
> referring to specific guest bindgen toolchains. It is **not** a constraint
> Zena needs to design around; we write our own bindgen.

### 2. An *exported interface* — you don't get one, you **implement** it.

`world service { export handler; }` means the host will call *you*. There is no
handle; there is an obligation. In Zena this is a class or function you write
plus a declaration binding it to the world's export.

### 3. A *resource* — **this** is the real handle.

`request`, `response`, `input-stream`, `fields` are resources: opaque `i32`
handles into a host-owned table. These you genuinely do construct
(`response.new(...)`), receive as parameters (the `request` passed to
`handle`), pass on, and must eventually drop. Ownership is tracked
(`own<T>` vs `borrow<T>`) and **moves** are real:

```wit
consume-body: static func(this: request, res: future<...>) -> tuple<stream<u8>, ...>;
```

`consume-body` is a *static* function taking `this` explicitly precisely because
it consumes the `request`. After that call the handle is dead.

**Summary answer**: interfaces are linked (in as many named slots as the world
declares), exports are implemented, resources are handles. Only the third is a
value with a lifetime.

---

## Part 2: What `import ... from` a WIT means in Zena

### The specifier

Zena already resolves bare specifiers as `package:path` through a package map
([package-manifest.md](./package-manifest.md)). WIT interface names have the
shape `namespace:package/interface@version`. The first two segments fit Zena's
existing grammar exactly:

```zena
import {Request, Response, Handler} from 'wasi:http/handler';
```

`wasi` is the package, `http/handler` is the path. **No new specifier grammar.**

Versions deliberately do *not* appear in the specifier — `@0.3.0-rc-2025-09-16`
is not valid in a Zena specifier and adding it would fork the grammar for one
consumer. The version is pinned in the resolution file, which is already where
Zena pins things:

```json
{
  "packages": {
    "wasi": {
      "wit": "./wit",
      "world": "wasi:http/service@0.3.0-rc-2025-09-16"
    }
  }
}
```

**DECIDE**: one WIT-backed package per WIT namespace (`wasi` → all of
`wasi:*`), or per WIT package (`wasi:http` → its own entry)? The former reads
better at the import site; the latter maps 1:1 onto WIT packages and versions
independently. Recommendation: per namespace, with per-package version pins
inside the entry.

### What the import *does*

It is a **linking declaration**, not a value binding. `import {send} from
'wasi:http/client'` asserts "this component's world imports `wasi:http/client`",
and binds `send` to it. Consequences that should be stated plainly in the
language reference:

- Importing an interface **adds it to the component's world**. Imports are not
  free; an unused import is still a host requirement. This is the opposite of
  Zena's normal imports and argues for DCE-driven world computation
  (**DECIDE**: does an import that is dead-code-eliminated stay in the world?
  Recommendation: no — compute the world from surviving imports after DCE, so
  the emitted component demands only what it uses).
- Importing the same interface in two modules with the same specifier yields
  **the same** instance — one import slot, deduplicated.
- Additional instances are available, but must be **named** (below).

### Named import slots

Because a world can import one interface into several named slots (Part 1),
Zena needs surface syntax for "give me *another* one, called this". Without it
the middleware shape — forward to an upstream `handler` while exporting
`handler` — is inexpressible in Zena even though it is expressible in WIT.

The natural fit for Zena's existing grammar is a subpath on the specifier, since
`package:path` already permits multiple segments:

```zena
import {Handler} from 'wasi:http/handler';             // the default slot
import {handle as upstream} from 'wasi:http/handler#upstream';
import {handle as fallback} from 'wasi:http/handler#fallback';
```

Each distinct `#name` becomes one `import <name>: wasi:http/handler;` in the
emitted world and one core import module (`cm32p2|upstream`). Omitting `#name`
selects the unaliased slot.

**DECIDE**: `#slot` on the specifier, versus declaring slots in the manifest and
importing them as distinct module names. The specifier form keeps the slot
visible at the use site; the manifest form avoids new specifier grammar. Weak
recommendation for the specifier form — the slot is load-bearing information
about the component's world and belongs where a reader will see it.

This is the piece that makes the capability story in the next section work at
the component boundary rather than only inside the guest.

### What bindgen emits

For each WIT interface, generate a Zena module with three layers:

1. **Raw functions** — direct, faithful, one Zena function per WIT function,
   canonical-ABI lowered. Zero cleverness.
2. **A Zena `interface`** mirroring the WIT interface, so callers can be written
   against a type rather than against ambient imports.
3. **A class implementing (2) by forwarding to (1)**, plus one singleton per
   declared import slot.

This is exactly the shape the stdlib already uses for console
(`console/interface.zena` declares `Console`; `console/wasi.zena` and
`console/host.zena` implement it; `zena-package.json` picks per target). WIT
bindgen generalizes an existing, working pattern rather than inventing one.

Layer 2+3 is what reconciles the Component Model with
[capabilities.md](./capabilities.md), which wants "capability received, not
imported" and mockable I/O. Zena code above the binding passes a `Handler` value
around, substitutes a fake in tests, and hands a restricted implementation to a
dependency — none of which the WIT layer sees or constrains.

The two sources of multiplicity compose cleanly, and it is worth being precise
about which is which:

- **At the component boundary**, each named import slot is a separate instance,
  wired by the host or composer. Real capability distribution: two `handler`
  slots can be satisfied by two different components.
- **Inside the guest**, any number of Zena objects can implement the generated
  interface — fakes, wrappers, restricting proxies — at no ABI cost and with no
  world changes.

So the capability model is not a workaround for a Component Model limitation, as
an earlier draft of this document claimed. Slots give genuine boundary-level
multiplicity; layer 2+3 gives unlimited in-guest multiplicity on top. Code
written against the generated interface does not care which it is given, which
is the property capabilities.md is after.

---

## Part 3: Exports

A world export is an obligation. The binding needs a way to say "this Zena
symbol satisfies it". Proposal:

```zena
import {Handler, Request, Response, ErrorCode} from 'wasi:http/handler';

@exports('wasi:http/handler')
export class MyServer implements Handler {
  handle(request: Request): Result<Response, ErrorCode> { ... }
}
```

Notes:

- The generated `Handler` interface is the contract, so `implements` gives you
  arity/type checking of the export for free.
- The class must be **no-arg constructible**: the p3 spec says "a host may
  arbitrarily reuse or not reuse component instance ... a component must be able
  to handle 0..N calls to `handle`". The generated glue owns instantiation.
- For single-function interfaces, allow `@exports` on a plain function; it is
  the common case and a class is ceremony.

**DECIDE**: `@exports('...')` decorator vs. a `world` declaration in
`zena-package.json` naming the implementing module. Recommendation: the
decorator — it keeps the obligation next to the code that satisfies it, and
`@external` already establishes the precedent for boundary decorators.

---

## Part 4: How this relates to wac

wac is a **composition** language. It operates on already-built components, and
in wac, instances *are* first-class values: you instantiate a component, maybe
several times, and wire specific exports into specific imports.

The difference is **not** one-instance versus many — Zena can declare as many
named import slots as it likes (Part 1). The difference is *declaring slots*
versus *filling* them:

| | wac | Zena source imports |
| --- | --- | --- |
| Operates on | built components | one component's own source |
| Instances | N, created and wired by the author | N, one per declared import slot |
| Decides *how many* | the composer | the component author |
| Decides *what satisfies each* | the composer, explicitly | not decided; left open |
| When | after compilation | at compilation |

So the two are complementary rather than competing. Zena's job is to emit one
well-formed component whose world declares the slots it wants — `upstream`,
`fallback`, the default `handler` — with accurate types. Choosing which
component ends up plugged into each slot is wac's job, and stays an out-of-band
step over components Zena emits.

This is a weaker and more accurate claim than an earlier draft of this document
made. The practical consequence for Zena is a *requirement*, not a limitation:
the import design must let an author name slots (Part 2), because a component
that cannot say "I want a second `handler` called `upstream`" cannot be
composed into a middleware chain no matter how good the composer is.

---

## Part 5: Type mapping

| WIT | Zena | Notes |
| --- | --- | --- |
| `u8`…`u64`, `s8`…`s64`, `f32`, `f64` | `u8`…`u64`, `i8`…`i64`, `f32`, `f64` | direct |
| `bool`, `char` | `boolean`, `char`/`u32` | **DECIDE**: Zena has no `char` |
| `string` | `String` | lift/lower through linear memory |
| `list<T>` | `Array<T>` | |
| `tuple<A, B>` | inline tuple | already unboxed multi-value |
| `option<T>` | `Option<T>` | existing `Some<T> \| None` |
| `result<T, E>` | `Result<T, E>` | **does not exist** — must be added to stdlib |
| `record` | case class | `class Point(x: f64, y: f64)` fits exactly |
| `variant` | sealed case-class hierarchy | pattern matching already exhaustive-checks these |
| `enum` | enum | |
| `flags` | bitfield over `u32`/`u64` | **DECIDE**: no obvious existing analogue |
| `resource` | `final class` wrapping an `i32` handle | see Part 6 |
| `own<T>` / `borrow<T>` | same class, differing lifetime rules | see Part 6 |
| `stream<T>` / `future<T>` | needs async | see Part 7 |

`result<T, E>` is a real stdlib gap. `Option<T>` exists; there is no `Result`.
Nearly every WIT function returns one, so bindgen cannot proceed without it.
It should be added as a normal union (`Ok<T> | Err<E>`) mirroring `Option`.

---

## Part 6: Resource lifetime

**Zena is GC'd. Component Model resources are linear and must be explicitly
dropped. WASM-GC has no finalizers.** Note that
[weak-references.md](./weak-references.md) solves its problem by delegating to
the JS host — that escape hatch does not exist inside a WASI component.

Three hazards, specific to WIT:

1. **Leaks.** Nothing drops a handle when the wrapper object becomes garbage.
   A server that leaks one `fields` handle per request dies in production.
2. **Use-after-move.** `request.consume-body(req)` invalidates `req`; Zena has
   no move checking, so the second use compiles fine and traps at runtime — or
   worse, hits a recycled handle index.
3. **Child-before-parent ordering.** `request-options` obtained from a `request`
   "must be dropped before the parent `request` is dropped".

This is not a WIT-specific problem. `zena:fs` descriptors, `zena:memory`
allocations, and FFI handles all have the same shape, and
[concurrency.md](./concurrency.md)'s `isolated<T>`/`frozen<T>`/`borrow` is the
same machinery from the parallelism side. The unified plan therefore lives in
**[ownership.md](./ownership.md)** rather than here.

### What that means for bindgen

The decisions this document depends on:

- **Generated resource wrappers carry `handle: i32` plus an
  `owned | moved | dropped` state flag.** Under affine checking most
  use-after-move becomes a compile error, but the flag is still required:
  conditionally-moved values cannot be resolved statically (Rust carries drop
  flags for exactly this), and it also encodes `borrow` vs `own`, since a
  borrowed handle must never be dropped by the callee.
- **Release is implicit** — ownership.md's sequencing decision is to build the
  ownership system rather than ship `using` as an interim mechanism, so an owned
  wrapper is dropped when it leaves scope unmoved. The scope-exit lowering is
  the `try`/`finally` both compilers already have.
- **A call-scoped arena is sugar on top**, not the foundation — an exported call
  releases whatever it registered and did not move out.
- **Bindgen marks consuming operations from day one**, even before anything
  enforces it, so that later affine checking is a switch rather than an
  excavation.

Sequencing: bindgen waits on the ownership model (ownership.md layers 0–2) so
that generated wrappers are written once against their final API rather than
against a runtime-flag model and regenerated later. Stages 1, 2, 4 and 6 below
are independent of ownership and proceed in parallel.

---

## Part 7: You can have an HTTP server *before* async

This matters for sequencing, so it deserves to be explicit.

**p3's `handler` is async and needs the whole CPS transform:**

```wit
// wasi:http@0.3.0-rc-2025-09-16
interface handler {
  handle: async func(request: request) -> result<response, error-code>;
}
```

**p2's `incoming-handler` is completely synchronous:**

```wit
// wasi:http@0.2.8
interface incoming-handler {
  handle: func(request: incoming-request, response-out: response-outparam);
}
```

p2 hands you a `response-outparam` instead of returning a response, and its
stream writes are blocking (`blocking-write-and-flush`). A p2 HTTP server
therefore needs **no `async`, no CPS transform, no waitable sets** — only
bindgen, the canonical ABI, resources, and component emission. It runs under
`wasmtime serve` today.

That makes p2 the right first target: it is reachable without the largest
unbuilt item on the roadmap, and every piece it forces us to build (lift/lower,
resource tables, `cabi_realloc`, component emission, bindgen) is needed
unchanged for p3. When async lands, p3 is a re-run of bindgen against a
different world plus the callback ABI.

### Sketch: p2 server, with generated bindings

```zena
import {IncomingHandler, IncomingRequest, ResponseOutparam,
        OutgoingResponse, Fields} from 'wasi:http/types';

@exports('wasi:http/incoming-handler')
export class Server implements IncomingHandler {
  handle(request: IncomingRequest, responseOut: ResponseOutparam): void {
    let response = new OutgoingResponse(new Fields());
    response.setStatusCode(200);
    let body = response.body();          // result<outgoing-body, _>
    ResponseOutparam.set(responseOut, ok(response));
    let stream = body.write();
    stream.blockingWriteAndFlush(bytes('hello from zena'));
    OutgoingBody.finish(body, none);
  }
}
```

Every call there is a plain synchronous call. The only machinery required is
faithful resource wrappers and the canonical ABI.

### The same thing on p3, once async exists

```zena
import {Handler, Request, Response, ErrorCode} from 'wasi:http/handler';

@exports('wasi:http/handler')
export class Server implements Handler {
  async handle(request: Request): Result<Response, ErrorCode> {
    let (response, transmitted) = Response.new(
      new Fields(), some(streamOf('hello from zena')), futureOk(none));
    return ok(response);
  }
}
```

Note how much p3 improves the shape — but also that `Response.new` returns a
tuple whose second element is a `future` you are expected to await for the
transmission result. **Bindgen should stay faithful and dumb**; ergonomics
belong in a hand-written `zena:http` layer above the generated bindings, not in
the generator.

### Middleware: why named slots earn their keep

`wasi:http/middleware` both imports and exports `handler` — the upstream and
downstream ends of a chain. With slot syntax (Part 2) that is directly
expressible:

```zena
import {Handler, Request, Response, ErrorCode} from 'wasi:http/handler';
import {handle as upstream} from 'wasi:http/handler#upstream';

@exports('wasi:http/handler')
export class Logger implements Handler {
  async handle(request: Request): Result<Response, ErrorCode> {
    log(`--> ${request.getMethod()}`);
    let response = await upstream(request);   // forward to the next handler
    log(`<-- done`);
    return response;
  }
}
```

The emitted world is `import upstream: wasi:http/handler; export
wasi:http/handler;`, and a composer decides what fills `upstream`. Without slot
naming this component cannot be written at all — which is the concrete reason
open question 2 is not cosmetic.

---

## Part 8: What has to be built

Ordered; each stage is useful on its own.

1. **Parser → compiler integration.** The parser now has a public entry point
   (`wit-parser:wit` — `parse`, `parseSyntax`, `resolve`, `toJson`) and is an
   entry in the root `zena-packages.json`, so any Zena code in the repo can
   import it. Real `wasi:http` parses and resolves today, p2 and p3 both.

   There is no bootstrap decision to make: the self-hosted compiler consumes the
   parser as source, like any other Zena package. (`wit-parser.md` used to carry
   a "Bootstrapping Strategy" section proposing a prebuilt `.wasm` checked into
   `packages/compiler`; that assumed the TypeScript compiler was the consumer,
   and has been removed.)

   What remains is making WIT imports *first-class*: a WIT-backed package
   resolving to a `SourceFile` whose `ModuleExports` are synthesized from the
   resolved WIT, so `import {Request} from 'wasi:http/types'` binds real symbols
   with no generated source. Blocked on the self-hosted compiler being able to
   compile `packages/wit-parser` at all — see BUGS.md, generic methods.
2. **`Result<T, E>` in the stdlib — as an inline multi-value union, not a
   heap type.** Blocks essentially every binding. **DECIDED 2026-08-05:** the
   representation is

   ```zena
   type Result<T, E> = inline (true, T, _) | inline (false, _, E);
   ```

   not a sealed class or a record union. Zena already has this idiom — the
   iterator protocol is `next(): inline (true, T) | inline (false, _)` — and
   inline tuples compile to WASM multi-value returns, so an ok/err return costs
   no allocation. Pattern-based narrowing (`if (let (true, v) = f())`) already
   works on it. See Part 8a for where this meets WIT.
3. **Bindgen, types only.** WIT types → Zena declarations. No ABI yet; output
   is checkable Zena source. Verifiable against real `wasi:http` WIT. Resource
   wrappers take their shape from stage 5, so this follows the ownership model
   rather than being written twice.
4. **Canonical ABI.** Lift/lower for string/list/record/variant/flags,
   `cabi_realloc` (build on the existing `FreeListAllocator` in
   `stdlib/zena/memory.zena`), post-return, and resource tables with the Part 6
   state flag in every generated wrapper.
5. **Ownership** — [ownership.md](./ownership.md): the checker flow graph, the
   `Disposable` drop protocol, affine `Own<T>`/`Borrow<T>`, and implicit drop.
   Independent of stages 1, 2, 4 and 6, and of Track G except for the
   cancellation question. Not a WIT-specific feature — it also settles
   filesystem.md's descriptors and linear-memory.md's open question 1. Stage 3
   (bindgen) depends on its API shape.
6. **Component emission.** Encode the `component-type` custom section from the
   resolved WIT, export `memory` + `cabi_realloc`, then `wasm-tools component
   new`. Shell out first; a native encoder later if it earns its keep.
7. **p2 HTTP server end-to-end** under `wasmtime serve`. This is the milestone
   that proves the stages above.
8. **p3**, after async/CPS lands: re-run bindgen against the p3 world, add the
   callback ABI, map `future`/`stream` onto Zena async.

### Part 8a: `Result` as an inline union, measured against real WIT

The inline representation fits WIT's *shape* exactly. WIT's `result` has four
forms and our parser already models them as `ResultKind(ok: TypeRef | null, err:
TypeRef | null)`, which maps onto the two arms with `_` in the unit slots:

| WIT | Zena |
| --- | --- |
| `result<T, E>` | `inline (true, T, _) \| inline (false, _, E)` |
| `result<T>` | `inline (true, T, _) \| inline (false, _, _)` |
| `result<_, E>` | `inline (true, _, _) \| inline (false, _, E)` |
| `result` | `inline (true, _, _) \| inline (false, _, _)` |

No conflict there — and `result<_, E>` is the single most common form in real
WASI (117 of 291 occurrences), which is exactly the case that benefits most from
not allocating.

**The constraint is position, not shape.** The language reference is explicit
that inline tuples "only exist in return position and destructuring — they
cannot be stored in variables or passed as arguments". Real WASI uses `result`
in all of those forbidden positions. Counted across the three pinned trees
(291 `result` occurrences total):

- **31** nested inside another generic — `future<result<_, error-code>>` (25,
  all of p3's async surface), `option<result<…>>`, `tuple<…, future<result<…>>>`
- **4** in parameter position —
  `consume-body: static func(this: request, res: future<result<_, error-code>>)`
- **2** nested in itself — `option<result<result<option<trailers>, error-code>>>`
  in `wasi:http` p2, where the outer result means "already taken" and the inner
  one is the actual outcome
- **1** as a record field — `response: result<outgoing-response, error-code>`

So roughly 88% of uses are plain return-position results the inline form covers
perfectly, and ~12% are positions it cannot occupy today.

**A second gap: binding both arms of one call.** The documented idiom for
inline unions is `if (let (true, v) = f())` / `while (let (true, v) = f())`,
which discards the false arm. That is sufficient for the iterator protocol,
whose false arm is `inline (false, _)` and carries nothing — but `Result`'s
false arm carries `E`. _(Corrected 2026-08-05: an earlier revision claimed the
error arm cannot be bound at all. It can — `if (let (false, _, e) = f())`
narrows correctly, now pinned by
`tests/language/execution/control-flow/if_let_result.zena`.)_ What is missing
is consuming **both arms of a single evaluation**: if-let's else branch sees
nothing, and `match` arms over an inline union do not narrow — the binding
gets the merged lane type (pinned by
`tests/language/semantics/control-flow/match/inline-union-arm-narrowing-unimplemented.zena`).
So adopting this representation implies one of:

- `match` over inline tuple unions with literal-pattern narrowing per arm, or
- an else-binding form, or
- an accessor pair that re-runs narrowing internally.

This is a language question, not a WIT one, but it lands before `Result` is
usable for anything that inspects the error — which is most of WASI, given
`result<_, error-code>` is the single most common form.
[result-option.md](./result-option.md) takes the question up in full — the
cross-language precedent (Rust, Swift, Zig), why the boolean tag stays in the
representation, an else-binding design sketch, and the proposed `??` /
error-forwarding sugar. Short version: `match` (below) remains the required
general form, and a Zig-style `else let (false, _, e)` binding is the
recommended ergonomic companion.

**Considered and rejected: destructure, then test the flag.**

```zena
let (ok, value, err) = foo();
if (ok) { /* value */ } else { /* err */ }
```

This does not typecheck usefully. Narrowing is `#narrowings:
Array<HashMap<SymbolId, Type>>` (checker.zena) — keyed by a *single* symbol — so
`if (ok)` narrows `ok` and nothing else; narrowing `value` off a test of `ok` is
correlated narrowing between distinct bindings, which that structure cannot
express. And with no literal in the pattern no arm is selected, so `value` is
typed `T | _` and `err` is `E | _`. Both branches then need a cast, and in the ok
branch `err` is a nameable, readable hole. For a language whose premise is a
sound type system with no implicit coercion, paying a cast at every call site is
the wrong trade.

**Recommended: `match` over inline tuple unions.**

```zena
match (foo()) {
  case (true, value, _): use(value)
  case (false, _, err): handle(err)
}
```

Per-arm narrowing, so no correlated narrowing is needed; the tuple is never
stored; the callee runs once; and exhaustiveness is decidable because `true` and
`false` are literal types, so two arms provably cover the union. `TuplePattern`
and `LiteralPattern` already exist (ast.zena), and literal-driven arm selection
is what `if (let (true, v) = …)` already does — the work is wiring `match` to
inline tuple unions, not new pattern machinery.

**OPEN — pick one before bindgen materialises `result`:**

- **(a) Two representations.** Inline in return position, boxed when nested or
  stored. Cheapest for the common path, but `Result<T, E>` is then not one type,
  and a WIT-derived signature's representation depends on where it appears.
- **(b) Let inline tuples nest and be stored.** A language change well beyond
  WIT, and it partly defeats the point: something stored has to live somewhere.
- **(c) Box only at the WIT boundary.** Keep the inline union as *the* Zena
  `Result`, and have bindgen introduce an explicit boxed carrier for the nested
  cases (a `Future<Result<…>>` wrapper class). Keeps the language unchanged and
  confines the cost to the 12%.

Recommendation: **(c)**. It leaves `Result` a single honest type, and every
nested case is already behind a `future`/`option`/`stream` that has to be a real
object anyway.

### Relationship to the plan of record

[implementation-plan.md](./implementation-plan.md) sequences the language arc
and puts **generators/async first** (Track G), with async's prerequisite being
G1, the split pass. This document describes a **Track W** that runs alongside
it. Stages 1–4 and 6–7 touch bindgen, the ABI, and emission — not ZIR, not the
suspension transform, not the record/equality arc. Nothing in Track G blocks
them and they block nothing in Track G.

Stage 5 (ownership) is the one exception: it is a genuine language expansion, so
it lands self-hosted-only under implementation-plan.md's rule 2, and it touches
the checker and the front end. It is still largely independent of Track G — the
scope-exit lowering desugars to `try`/`finally`, which exists today and owes
nothing to the split pass. The single real coupling is who drops resources held
in a cancelled task's state machine, which needs G1.

The tracks converge at stage 8. Note that implementation-plan.md puts JSPI
ahead of the WASI P3 callback ABI as the first async host driver, so p3 HTTP is
downstream of *both* Track W stages 1–7 and Track G's second host driver. That
is a further argument for taking p2 first: it is the only HTTP milestone
reachable on Track W alone.

---

## Part 9: Parser and resolver gaps blocking real WASI WIT

**Status: all five gaps are fixed. Every real WASI tree we pin parses and
resolves — WASI 0.2 (`wasi:http@0.2.8` + 6 deps, 7 packages / 31 interfaces /
9 worlds), the `0.3.0-rc-2025-09-16` draft (6/25/8), and released **WASI 0.3.0**
from `WebAssembly/WASI` (6/25/8). `npm test -w @zena-lang/wit-parser` checks all
three against pinned copies, with exact counts.**

The parser passed every wasm-tools UI test while being unable to handle any real
WASI package, because the upstream UI corpus does not cover these combinations.
Each was isolated to a minimal repro:

### Gap 1 — prerelease/build semver in a `use`/`import` path

```wit
package test:probe;
interface i { use foo:bar/baz@1.0.0-alpha.{a}; }   // ParseError: unexpected token
```

`@1.0.0` parses; `@1.0.0-alpha`, `@1.0.0-rc-1`, `@1.0.0-rc.1`,
`@0.3.0-rc-2025-09-16`, `@1.0.0+build` all fail. Prerelease versions parse fine
in a `package` declaration and in `@since(version = ...)` — the gap is specific
to the use-path version parser (`#parseVersion`, `parser.zena:1275+`, versus
the working `#parseVersionString` at `:1188`).

**Blocks: all of WASI p3**, since every p3 package is `@0.3.0-rc-2025-09-16`.

### Gap 2 — versioned interface path in a world `import`/`export`

```wit
package test:probe;
world w { import wasi:clocks/monotonic-clock@0.2.8; }   // ParseError: unexpected token
```

Plain semver, no prerelease. `include wasi:http/imports@0.2.8;` parses
correctly, so the include path handles versions and the import/export path does
not.

**Blocks: the p2 `proxy` world and the p3 `service`/`middleware` worlds** — i.e.
exactly the worlds an HTTP server targets.

### Gap 3 — doc comment inside a function parameter list

```wit
package test:probe;
interface i {
  f: func(
    /// how many
    len: u64
  ) -> u32;
}
// ParseError: expected identifier
```

Plain `//` comments in the same position are fine, and `///` is fine inside
records, variants, and resource bodies. Only parameter lists break.

**Blocks: `wasi:io/streams`, `wasi:filesystem/types`, `wasi:sockets/*`** — which
transitively blocks nearly every WASI world.

Reproduce with `node packages/wit-parser/dev/parse-real-wit.js --probe`.

### Gap 4 — an interface name shadowed by a type bound from an earlier `use`

```wit
package test:shadowing;
interface network { resource network; }
interface tcp { use network.{network}; resource tcp-socket { } }
interface tcp-create-socket {
  use network.{network};      // binds a *type* called `network`
  use tcp.{tcp-socket};       // recurses into tcp's own `use network.{…}`
}                             // ParseError: `network` is not an interface
```

A `use` path was resolved with a general symbol lookup that walks every
enclosing scope, so the type won over the interface. World `include` paths
already avoided this by looking specifically for world definitions; `use` now
looks specifically for interfaces, falling back to the symbol table so that
interface *aliases* (`use foo as bar;`), which exist only there, still resolve.

**Blocked: all of `wasi:sockets`**, and so `wasi:cli` and `wasi:http` with it.
Covered by `tests/interface-shadowed-by-use.wit`.

### Gap 5 — same interface name in two packages

```wit
package test:clocks@1.0.0;
interface types { type duration = u64; }
interface monotonic-clock { use types.{duration}; now: func() -> duration; }

package test:sockets@1.0.0;
interface types { use test:clocks/monotonic-clock@1.0.0.{duration}; }
// ParseError: interface `test:clocks@1.0.0/monotonic-clock` depends on itself
```

Resolving the cross-package `use` recurses into `monotonic-clock`, whose own
unqualified `use types.{duration}` must mean `test:clocks/types`. It was answered
from the scope stack instead, which yields the `types` currently being resolved
in the *other* package, so the two appeared mutually dependent.

The fix threads the **owning package** — the package of the interface a `use`
sits in — through `#validateUseNames`, `#findItemInInterface` and
`#getUseNameKind`, so an unqualified path resolves against that package rather
than against whatever is nearest on the scope stack.

> **A correction.** An earlier revision of this document claimed the blocker was
> that `#currentResolvePackage` is only updated for nested `package x { … }`
> blocks and not for repeated file-level `package …;` declarations. That is
> wrong: the parser turns a second file-level package into a `NestedPackage`
> (parser.zena, `#parseAstItem`), and the resolver does set the package context
> for those. The real reason a registry lookup alone was not enough is that
> removing the false cycle exposed an **unguarded mutual recursion** between
> `#findItemInInterface` and `#getUseNameKind` — they follow `use` chains to
> work out whether an imported name is a type or a resource, and had no notion
> of which package owned the interface being inspected, so two packages with
> same-named interfaces bounced between each other until the stack blew. The
> bogus "depends on itself" error had been the only thing stopping it.

**Unblocked: all of WASI p3**, both the `0.3.0-rc-2025-09-16` draft and released
`0.3.0` — 6 packages, 25 interfaces, 8 worlds each. Regression test:
`tests/cross-package-name-collision/`.

Worth noting for the async work: released 0.3.0 is where `async func`, `stream<T>`,
`future<T>` and `error-context` actually appear (36 `async func` alone across the
draft), so the parser is already handling that surface — it is the *bindgen* and
canonical-ABI sides that remain unbuilt.

---

## Open questions (collected)

1. Resource lifetime — the WIT-facing decisions are settled (Part 6); the
   cross-cutting ones now live in [ownership.md](./ownership.md).
2. Named import slots: `#slot` on the specifier vs. manifest-declared slots
   (Part 2). Blocks middleware-shaped components either way.
3. WIT-backed package granularity: per namespace or per WIT package (Part 2).
4. Does a DCE'd import stay in the emitted world (Part 2)?
5. `@exports` decorator vs. manifest declaration (Part 3).
6. `char` and `flags` representations (Part 5).
7. Do we ever emit components natively, or is `wasm-tools` a permanent
   dependency (Part 8, stage 6)?

## Related

- [wit-parser.md](./wit-parser.md) — the parser (done)
- [wasi.md](./wasi.md) — earlier, now partly superseded sketch
- [console-wasi-strategy.md](./console-wasi-strategy.md) — componentization pipeline
- [capabilities.md](./capabilities.md) — capability values; reconciled in Part 2
- [ownership.md](./ownership.md) — the unified resource-management plan (Part 6)
- [filesystem.md](./filesystem.md) — the original `Disposable`/`using` sketch
- [exceptions.md](./exceptions.md) — `try`/`finally`, which `using` desugars to
- [concurrency.md](./concurrency.md) — async/CPS (prerequisite for p3 only), and
  `isolated<T>`/`frozen<T>`/`borrow`, the ownership machinery affine types
  would share (Part 6)
- [implementation-plan.md](./implementation-plan.md) — plan of record; this doc
  is an orthogonal track (Part 8)
- [linear-memory.md](./linear-memory.md) — `zena:memory`, and the same `using`
  proposal reached independently (Part 6)
- [package-manifest.md](./package-manifest.md) — specifier and resolution machinery
