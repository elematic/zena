# Streams

Status: **Proposal** (2026-08), with the in-language core implemented
(`zena:stream`). The design WASI 0.3 interop consumes: WIT `stream<T>`
crosses component boundaries, and a Zena stream that shares its shape
needs no adapter layer there. Cancellation integration follows
[cancellation.md](cancellation.md); async iteration builds on the
`AsyncIterator<T>` shape [generators.md](generators.md) §8 reserves.

The organizing decisions: **the stream is a rendezvous, not a queue**
(the only state a stream holds is the one pending write's slice and
the one pending read's buffer — no elastic storage, no capacity
policy);
**reads are batched, with one contract for bytes and objects**; and
**the stream carries elements while a future carries the outcome**.

## The shape WIT dictates

WASI 0.3's `stream<T>` is opinionated, and the opinions flow inward
rather than being adapted at the boundary:

- **Rendezvous semantics.** A read supplies a buffer of up to N
  elements; a write completes against pending reads. Data moves when a
  read and a write overlap; the ABI holds no intermediate buffer.
  Backpressure is intrinsic — a writer that outpaces its reader waits —
  rather than an advisory signal layered on top.
- **Batched, buffer-supplying reads.** The reader owns the buffer
  (bring-your-own-buffer by construction), and `stream<u8>` flattens
  to memory copies.
- **Two ends, as separate affine resources**, and drop is the
  protocol: dropping the readable end fails the peer's writes as
  closed; dropping the writable end is end-of-stream.
- **No error channel.** A stream ends; the outcome travels separately
  (`wasi:http@0.3`: `body: stream<u8>` beside a
  `future<result<trailers, error-code>>`). End-of-stream is a status a
  read returns — data addressed to the caller, never an unwind.

## Survey

**WHATWG streams** share this model — pull-driven readers, intrinsic
backpressure intent, BYOB byte reads, separate ends, out-of-band
cancel — and the model is what carries over. The API surface does
not: reader locks, controllers, and the `tee` machinery exist to
simulate exclusive ownership dynamically in a language where any
reference aliases. Zena's ownership regime makes possession of the
read end the lock, statically. Field experience with the surface is
documented in Cloudflare's
[critique](https://blog.cloudflare.com/a-better-web-streams-api/):
advisory backpressure that producers ignore (`enqueue` always
succeeds), `tee`'s unbounded buffering cliff, eager transforms, and —
most quantified — per-element promise and object allocation dominating
throughput (their async-iteration benchmarks run 15–100× behind
batch-oriented alternatives, with GC beyond 50% of CPU in streaming
SSR). Its proposed replacement is a JavaScript-local optimum — it
abandons consumer-owned buffers entirely, where the Component Model
went the opposite way — but its evidence fixes two requirements here:
batch-first as the only core read, and iteration that compiles down to
it.

**Dart streams** are the wrong model for this boundary despite the
best consumption ergonomics in the family: push-based subscriptions,
errors in-band with data, pause/resume backpressure — each conflicts
with the rendezvous shape. What carries over is the syntax story:
`async*` producing and `await for` consuming map onto Zena's existing
`gen` bodies and `for`-in.

## Two layers

An async iterator and a stream are different things, both earned:

- **`Stream<T>` is the resource** — batched, byte-fast, droppable,
  what crosses component boundaries and what bulk in-language code
  uses directly.
- **`AsyncIterator<T>` is the protocol** — what `async gen` bodies
  produce, what `for`-in consumes, element-wise and ergonomic.

A stream adapts to the protocol for consumption, and the seam between
the layers is where the compiler earns its keep (fusion, below).

## The read contract

```zena
read(buf: FixedArray<T>): Future<i32>
```

**Between 1 and `buf.length` elements, into a buffer the caller owns;
`0` is end-of-stream.** The 1..N contract is the hinge that makes
batch-first universally correct rather than a bytes-only optimization:

- A high-rate producer fills batches — throughput of N per queue hop.
- A low-rate producer completes the read the moment one element
  exists — `count = 1`, the same latency as an element-wise protocol,
  through the same API, with no mode switch.
- An element-at-a-time read is the degenerate batch, not a second
  protocol.

Batching is independent of bytes. The buffer is generic: for
`Stream<Foo>` it is an array of references and filling it moves refs
and copies nothing — the batch amortizes the async machinery (one
future and one hop per batch, one reusable buffer per loop) rather
than avoiding data copies. For `Stream<u8>` the same contract
additionally becomes the memcpy fast path. `FixedArray<T>`'s
constructor requires a fill value, so a buffer for a non-nullable
element type is built once with a placeholder and reused; reads
overwrite a prefix and report `count`, and only `[0, count)` is
meaningful — the same discipline `GrowableArray`'s backing store
already uses.

## Ends and capabilities

`new StreamWriter<T>()` creates the pair, mirroring `Completer`
(async.md §2, and the settle split that made it the enforced write
capability): the writer is the write capability, and its `.stream` is
the value handed out. A `Stream<T>` reference confers reading;
nothing on it writes.

```zena
let w = new StreamWriter<String>();
consume(w.stream);          // reader side
let ok = await w.write('a'); // false once the reader has stopped
w.close();                   // end-of-stream: reads complete with 0
```

- `write(value): Future<boolean>` — the future completes when the
  value is consumed into a read (the rendezvous; awaiting it is the
  backpressure) or immediately with `false` when the reader has
  stopped. A stopped reader is data to the writer, not a failure —
  the WIT `DROPPED` status, `Result`-shaped.
- `close()` ends the stream; pending and subsequent reads complete
  with `0`.
- `stop()` on the stream is the reader disclaiming: parked writes and
  subsequent `write`s complete `false`. Under
  [cancellation.md](cancellation.md), a cancelled consumer reaches
  the same state through cleanup — the pending read raises at its
  checkpoint, and `using`/ownership releasing the read end performs
  the stop; at a component boundary that release is the ABI's
  readable-end drop, so the cleanup path and the wire signal are one
  path.
- Both ends are exclusive: one read and one write may be pending at
  a time, matching the WIT ABI, where each end is one resource with
  one operation in flight. The ends are affine in intent; until move
  checking enforces that, a concurrent operation throws.
- The batch a read drains is the pending write's slice.
  `writeAll(buf, count)` is the ABI's buffer-carrying write — the
  slice belongs to the stream until the write's future completes,
  which happens when the last element is consumed — and
  `write(value)` is its one-element form.
- Fan-in from several producers is an explicit multiplexing adapter
  over one writer, exactly as fan-out is an explicit `share` over one
  reader: neither implicit `tee` nor implicit merge, for the same
  unbounded-interleaving reasons.

## Errors: elements on the stream, outcomes on a future

The stream carries no error channel, matching WIT. Whatever produced
the stream exposes how it ended as an ordinary future beside it — the
`wasi:http` trailers shape generalized. The iteration layer *can*
fail, because `next()` returns a future and futures fail: an
`async gen` body's throw ends its stream and fails its outcome
future, and the `for`-in desugaring awaits both, so the throw
surfaces at the consuming loop like any awaited failure. One rule,
stated once, at both layers.

## Iteration and fusion

`AsyncIterator<T>` is `next(): Future<Option<T>>` — the boxed shape
rather than generators.md's sketched inline tuple, because a
`Future` of an inline tuple has no lowering (the zero-width-lane
family). A stream adapts to it trivially, at one future and one
queue hop per element.

That cost is why **`for`-in over a `Stream<T>` fuses**, as a
requirement rather than an optimization: the loop compiles to a
batched `read` per iteration of an outer loop and a synchronous
cursor over `[0, count)` inside — one future and one hop per batch,
per-element cost only at the true seams. This is the async analog of
the array `for`-in fusion, and its lesson applies verbatim: root what
the lowering calls, mirror its dispatch. The Cloudflare numbers are
the sizing of what this buys (their async-iteration gap is 15–100×,
attributed to per-element promise and result-object allocation).

`async gen` bodies (generators.md §8) produce through the same
machinery from the other side: `yield` writes, with the generator's
laziness preserved — the body runs when read, which is also what the
rendezvous wants. The eager-start rule is async *functions'*; an
async generator starts at first read, matching `gen`.

## The WIT boundary

Only WIT-typed streams cross it. `Stream<u8>` (over `FixedArray<u8>`,
the narrow-int item of the WIT-interop plan) is the memcpy path;
streams of WIT records and variants stage through the component
adapter's linear memory as bindgen dictates. The constraint attaches
at the boundary declaration like every other WIT type check — it is
not a property of `Stream<T>`, and in-language object streams are
unrestricted. Lifting and lowering are the component track's work;
this document fixes the shape they bind to: reads and writes map to
`stream.read`/`stream.write` with the same 1..N contract, `close` to
the writable-end drop, `stop` to the readable-end drop, and pending
operations to the task's waitable set.

## The JS boundary

Zena streams must also cross to JavaScript with WASI nowhere in the
picture — a Zena-produced body consumed by a web caller, a web
`ReadableStream` (a fetch body) consumed by Zena. The mapping is thin
because WHATWG streams are pull-based like the rendezvous: a
`pull()` is a batched read, and backpressure holds end to end without
translation.

- **Zena to JS**: the runtime wraps the read side as
  `new ReadableStream({pull})`, each pull driving one batched read.
  JS cannot call generic Zena methods, so the JS-facing surface rides
  the machinery fetch already uses: a target-gated binding whose
  exports issue reads and hand bytes out (the `$stringGetByte`
  pattern generalized to `FixedArray<u8>`), with completions over the
  host-async handle protocol. Close and stop map to
  `controller.close()` and the pull loop observing `stop`.
- **JS to Zena**: the mirror of fetch's response handling — the
  runtime holds the JS reader (BYOB for bytes), each Zena read issues
  a host-async operation by handle, and the runtime completes it with
  the chunk. Zena's `stop()` becomes `reader.cancel()`; the JS
  stream's end completes reads with 0.

What `@zena-lang/runtime` needs, concretely: a **byte-chunk
completion kind** beside void/i32/f64/string — either
`__zena_complete_bytes` writing through an exported byte-buffer
writer (the `createStringWriter` shape without the string wrapper),
or, once [host-interop.md](host-interop.md)'s reference handles land,
chunks crossing as host references with the copy on the Zena side —
plus two adapters (`readableFromZenaStream`,
`zenaStreamFromReadable`) participating in the existing
outstanding-work accounting so `run()` waits on in-flight stream
I/O. Nothing is needed per API beyond that, and only byte (and
WIT-representable) streams cross — arbitrary object streams are
in-language, the same constraint the WIT boundary imposes. The first
consumer is fetch: `Response` grows a streamed body over
`zenaStreamFromReadable`.

## Sequencing

1. **The in-language core** (this change): `zena:stream` — the
   rendezvous, the read contract, close/stop — as a pure library,
   portable to every target.
2. **WIT lifting/lowering** on the component track, binding to the
   core's shape.
3. **The JS boundary** in `@zena-lang/runtime`: the byte completion
   kind and the two adapters, with fetch's streamed body as the first
   consumer.
4. **`AsyncIterator<T>` + `for`-in over async iterators**, with
   stream fusion (compiler).
5. **`async gen`** producing via the writer side (compiler; the
   split-pass machinery both existing passes share).
6. **Reader-end release via cancellation/ownership** once the
   cancellation tag lands: scope cancel raises the pending read,
   `using` performs the stop.

## Alternatives considered

- **A queue with watermarks** (WHATWG's internal shape). Rejected:
  advisory backpressure is the documented failure mode, and the WIT
  ABI is a rendezvous — an internal queue would be an impedance layer
  against the boundary this exists to serve.
- **Async-iterable as the foundation** (the Cloudflare alternative).
  Rejected as foundation, adopted as protocol: it erases the resource
  layer (ends, drops, transferability) that component interop
  requires, and per-element futures are the measured cost its own
  benchmarks indict.
- **Push subscriptions** (Dart). Rejected: push inverts the boundary's
  pull model and puts errors in-band.
- **Producer-allocated result batches** (`read(): Future<Array<T>>`).
  Rejected for the core: it abandons consumer-owned buffers, which
  the byte path needs for zero-copy; the fill-value wart of
  caller-owned `FixedArray<T>` buffers is the cheaper cost.
