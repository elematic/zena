# Sharing a stream: explicit fan-out

[streams.md](streams.md) commits to fan-out as "an explicit `share`
over one reader" and stops there. This document designs it: the
adapter that turns one rendezvous `Stream<T>` into N independently
consumable ones, and the policy surface that decides what happens
when a subscriber cannot keep up. It is the missing piece between
streams and every object that broadcasts events — a task's
transitions, a watcher's file events, a socket's frames read once and
rendered twice.

The one-line reason this is a distinct type rather than a `tee`
method: with a single producer and N consumers at different speeds,
SOMETHING must give — the producer waits, an element drops, or a
buffer grows. The web's `tee` picks silent unbounded growth, the
cliff streams.md's survey rejects on Cloudflare's evidence. `share`
makes the choice per subscriber, in the signature, because no default
is right for all three of the consumers above.

## The shape

```zena
export class Share<T> {
  /** Takes the read end. The source has one reader — this is it. */
  new(source: Stream<T>);

  /** A fresh stream of the source's elements from this point on,
   * delivered under `policy`. The subscription is a resource: drop
   * it (or leave its `using` scope) and it detaches. */
  subscribe(policy: Policy): Subscription<T>;

  /** Drives delivery: reads the source and fans batches out until
   * end-of-stream, then closes every subscription. The caller owns
   * this future the way it owns any pump — spawn it in the scope
   * that owns the share. */
  run(): Future<void>;
}

export resource class Subscription<T> {
  stream: Stream<T> { get }
}
```

`run()` rather than a self-spawned pump: a pump must be somebody's
child, and the type cannot know whose. The owner spawns it —
`group.spawn(() => share.run())` — and cancellation of that scope is
what tears the share down, sources and subscriptions alike. This is
the same answer task.md gives for its transitions forwarder, one
level up.

A subscription is a `resource class` because dropping one silently
must detach it. Under `Waits` (below) an abandoned subscriber would
otherwise park the pump forever — the pump cannot distinguish "slow"
from "gone" — and under any policy it would hold buffered elements
alive. Detach-on-drop turns both leaks into a non-event, and `using
sub = share.subscribe(Policy.Conflate)` scopes an observer the way
`using` scopes any resource.

## The policies

```zena
export enum Policy {
  /** One slot holding the latest undelivered element; a newer one
   * replaces it. The pump never waits on this subscriber. For state,
   * where only the current value matters. */
  Conflate,
  /** Waits: the pump does not advance past an element until this
   * subscriber has read it, which holds the PRODUCER to the slowest
   * such subscriber through the source's own backpressure. For
   * pipelines, where every element matters and loss is worse than
   * waiting. */
  Waits,
}

/** Lossless up to `n` queued elements, then the pump waits. `Waits`
 * is `buffered(0)`; a lossy bounded queue (drop-oldest) can join the
 * enum when a consumer earns it. */
export let buffered = (n: i32): Policy => { ... };
```

Three shapes, one axis: how much divergence between producer and this
consumer is absorbed, and by what. `Conflate` absorbs unlimited
divergence by dropping intermediates; `buffered(n)` absorbs `n` by
memory; `Waits` absorbs none and couples rates. Unbounded buffering
is deliberately not expressible — it is the option every other system
defaults to precisely because its cost arrives latest.

## Delivery

The pump loop is the batch discipline streams.md already fixed: read
up to a batch from the source, then offer the batch to each
subscription in subscribe order — conflating slots overwrite, buffers
fill, and the pump awaits the `Waits`/full-buffer subscribers before
the next source read. Per-subscriber order is the source's order;
what `Conflate` drops it drops wholesale (a subscriber never sees
reordering, only gaps). Source end-of-stream closes every
subscription's stream after its remaining elements drain; a source
failure follows the streams.md rule — elements on the stream,
outcomes on a future — surfacing on `run()`'s future and closing
subscriptions.

Subscribing after `run()` has begun sees elements from the next batch
on: a share is a broadcast of "from now on", not a replay. Replay is
a cache keyed by history — a different type with a different memory
story, the same line task.md draws between a task and a query cache.

## Who owns the share

Exposing one raw stream does not settle the slow-observer problem —
it hands a single observer the power to park the producer without
ever saying so. Whether that is a bug or the contract depends on one
question: **can this producer meaningfully wait?**

- **Demand-paced producers** — a file reader, a socket, a transform
  stage — exist to run at their consumer's rate. They expose the raw
  stream, and a slow consumer slowing them IS backpressure working.
  Wrapping these in a `share` by reflex would launder away the
  pipeline's flow control.
- **Self-paced producers** — state transitions, timer ticks, input
  events — cannot wait without corrupting the thing they report. A
  self-paced type owns a `Share` internally and exposes
  `subscribe(policy)` proxying it, with **no default policy**: the
  proxy is precisely the point at which each observer is made to say
  what absorbs the divergence, which the raw stream never asked. A
  producer for which waiting is not merely costly but wrong offers
  only the non-waiting policies — its `subscribe` takes `Conflate`
  or `buffered(n)` and does not mention `Waits`.

A default policy on the proxy would reintroduce the silent choice
this design exists to remove; "accepting the risk" is choosing
`Waits` for every observer without telling them. Both spellings of
the same mistake.

## What this displaces

Without `share`, every broadcasting object grows an observer list, a
notification method, and an ad-hoc answer to the slow-observer
problem — three decisions per type, each made once per library and
wrong somewhere. With it, a demand-paced type exposes its stream, a
self-paced type proxies `subscribe(policy)` (or ships the
single-subscriber conflating case, task.md's `changed()`), and
`share` is where multiplicity and rate divergence are handled, once.

## Sequencing

Library-only; no compiler work. It wants `Subscription` as a
`resource class` with a synthesized dispose (Track O stage 1,
merged), and its tests want `Task.changed()`'s pattern for the
conflating case. Implementation order: `Policy`/`Subscription`
skeleton and the pump under `Waits`, then `Conflate`, then
`buffered(n)` — each policy's tests assert the pump-side property
(who waited, what dropped) rather than only the subscriber-side
values.
