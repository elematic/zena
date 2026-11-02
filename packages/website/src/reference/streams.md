---
title: 'Streams'
description: 'Asynchronous streaming in Zena: rendezvous streams, StreamWriter, batch reads, backpressure, and multicast fan-out.'
---

::: warning Active Development
Concurrency and asynchronous APIs in Zena are under active development.
Specifications, runtime behaviors, and standard library interfaces described on
this page are incomplete and evolving.
:::

Streams in Zena represent asynchronous sequences of data transferred between a
producer and a consumer. Rather than using internal queues, Zena's stream model
in `zena:stream` uses a **rendezvous architecture**: elements transfer directly
from the writer's memory slice into the reader's buffer, matching the
WebAssembly Component Model WIT stream ABI (see [References](#references)).

Like JavaScript's BYOB ("Bring Your Own Buffer") streams, consumers supply
reusable buffers (`FixedArray<T>`) to eliminate per-chunk heap allocations. In
Zena, this applies to all data types, not just byte streams.

## The Stream interface

`Stream<T>` represents the readable capability of an asynchronous data stream:

```zena
import { Stream } from 'zena:stream';
```

### Streams and async iteration

`Stream<T>` is not the per-element iteration interface. A stream is a batched,
exclusive 1-to-1 I/O resource designed for bulk data transfer without intermediate
allocations.

Per-element consumption is the role of **async iteration** (`for await` loops and
the async iterator protocol; see [for await](/reference/loops/#for-await)), which
is under active implementation on the roadmap. When async iteration lands,
streams will adapt to it, and the compiler will lower `for await (let item in stream)`
loops into batched `read()` calls to preserve zero-copy batch throughput while
providing ergonomic per-element iteration.

### The rendezvous model

The rendezvous architecture has four core characteristics:

- **Zero intermediate buffering**: The stream holds no internal queue. It holds
  only a reference to the active writer's slice or active reader's buffer. Data
  moves only when a write and a read meet.
- **1-to-1 exclusive ends**: Each stream connects exactly one `StreamWriter<T>` to
  one `Stream<T>`. At most one read and one write may be in flight; attempting
  concurrent reads or concurrent writes throws a runtime error.
- **Fan-out requires a buffering consumer**: Because a producer writes directly
  into a consumer's buffer, a raw stream cannot broadcast to multiple readers.
  Fan-out requires an explicit adapter like `Multicast<T>`, which acts as the
  single reader and manages a shared buffer with explicit lag policies.
- **Structural backpressure**: A writer's `await writer.write(item)` cannot
  resolve until a reader accepts the data into its buffer.

## Producing streams

The write capability is encapsulated by `StreamWriter<T>`:

```zena
import { StreamWriter } from 'zena:stream';

let writer = new StreamWriter<String>();
let stream = writer.stream; // Pass to reader
```

### Writing elements

A producer delivers data to the stream through `write()` or `writeAll()`:

- **Single element (`write`)**:
  ```zena
  if (let (false, item) = await writer.write('item')) {
    // The reader stopped: `item` is back with the writer.
  }
  ```
  Returns a `Future<Result<void, T>>` that resolves to `(true, _)` once a
  reader has taken the item, or to `(false, item)` if the reader stopped
  first, handing the item back. That is what lets a stream carry owners: at a
  restricted element type, such as `Own<File>`, make the pair with
  `StreamWriter.create<Own<File>>()`, since the stream has one reader.
- **Batch write (`writeAll`)**:

  ```zena
  let chunk = new Array<String>.fixed(3, '');
  chunk[0] = 'alpha';
  chunk[1] = 'beta';
  chunk[2] = 'gamma';

  let delivered = await writer.writeAll(chunk);
  ```

  Writes up to `count` elements (defaulting to `buf.length`). The buffer belongs
  to the stream until the returned future settles.

### Handling reader termination and close

- **Reader disclaim**: If the reader calls `stream.stop()`, or drops a stream of
  owners, in-flight and subsequent `write` futures hand each value back as
  `(false, value)`, and `writeAll` futures complete with `false`. This signals to
  the producer that the reader has ceased reading, without throwing an
  exception. Dropping a writer of owners closes its stream.
- **Closing the stream (`close`)**:
  ```zena
  writer.close();
  ```
  Marks the end of the stream. Any elements remaining in an active pending write
  are delivered first; once drained, subsequent reads evaluate to `0`. Writing
  after `close()` throws an error.

## Consuming streams

Consumers read data into caller-allocated buffers using `stream.read()`:

```zena
let buffer = new Array<String>.fixed(64, '');
var count = await stream.read(buffer);

while (count > 0) {
  for (var i = 0; i < count; i += 1) {
    processItem(buffer[i]);
  }
  count = await stream.read(buffer);
}
```

### The 1..N read contract

- **Caller-owned buffer**: `read(buf)` copies available elements into indices
  `0` through `count - 1` of `buf`.
- **Batch delivery**: `read()` completes with between `1` and `buf.length`
  elements as soon as any elements are written. It does not wait for the buffer
  to fill completely before resolving.
- **End-of-stream**: When the stream is closed and all written elements have been
  consumed, `read()` completes with `0`.

### Stopping a stream

A reader that no longer needs further data calls `stream.stop()`:

```zena
stream.stop();
```

- Any pending writer future is completed with `false`.
- Any subsequent calls to `stream.read()` immediately resolve to `0`.
- Calling `stop()` allows producers to clean up resources early without hanging.

### Reading all bytes

For byte streams (`Stream<u8>`), the standard library provides `readAllBytes`:

```zena
import { readAllBytes } from 'zena:stream';

let allBytes: FixedArray<u8> = await readAllBytes(byteStream);
```

This reads chunks repeatedly until end-of-stream and concatenates them into a single
`FixedArray<u8>`.

## Transformations and combinators

When a stream must be delivered to multiple concurrent consumers, use `Multicast<T>`:

```zena
import { Multicast, waits, buffered, conflate } from 'zena:stream';

let scratch = new Array<SensorReading>.fixed(32, defaultReading);
let multi = new Multicast<SensorReading>(sensorStream, scratch);

// Create subscriptions with specific delivery policies:
let criticalSub = multi.subscribe(waits);
let telemetrySub = multi.subscribe(conflate);
let archiveSub = multi.subscribe(buffered(256));

// Start the broadcast loop:
await multi.run();
```

### Shared ring buffer

`Multicast<T>` coordinates fan-out through a single internal ring buffer shared
by all subscribers:

- Each subscription maintains an independent cursor pointing into the ring.
- Elements are pruned from the ring only after the slowest active cursor has
  passed them.
- Memory consumption is determined by the lag of the slowest subscriber rather
  than multiplying with every added subscriber.

### Subscription lifecycle and disposal

A `Subscription<T>` represents a subscriber's handle:

- Access its dedicated stream via `sub.stream`.
- Implements `Disposable`: disposing a subscription detaches it from the
  multicast pump and stops its stream.
- Using `using` guarantees that abandoned subscribers do not keep the ring buffer
  from advancing:

```zena
using let sub = multi.subscribe(waits);
let stream = sub.stream;
// When exiting scope, 'sub' detaches automatically
```

## Backpressure

Backpressure ensures that fast producers do not overwhelm slow consumers or
exhaust system memory.

### Point-to-point stream backpressure

In a single `Stream<T>`, backpressure is intrinsic to the write operation:

1. The producer calls `await writer.write(item)` or `await writer.writeAll(buf)`.
2. The returned future remains pending until the consumer's `read()` has copied
   the data.
3. The producer's async execution pauses at the `await` until the consumer is
   ready for the next chunk, bounding memory usage to the active slice.

### Multicast backpressure policies

When broadcasting via `Multicast<T>`, different consumers may have different latency
requirements. Each subscriber specifies its own `Policy`:

- **`waits` (`Waits`)**: Strict, lossless backpressure. The multicast pump will
  not advance past an unread element for this subscriber. The producer's speed is
  governed by the slowest `waits` subscriber.
- **`buffered(n)` (`Buffered`)**: Lossless up to a bounded capacity. Allows the
  subscriber to lag by up to `n` elements in the shared ring. If the lag exceeds
  `n`, the pump pauses until the subscriber catches up.
- **`conflate` (`Conflate`)**: Lossy, low-latency sampling. The pump never pauses
  for this subscriber. If new items arrive before previous items are read, the
  subscriber's cursor jumps forward to the newest item, dropping intermediate
  values. Ideal for UI updates, telemetry metrics, and state synchronization.

## References

- [WebAssembly Component Model Async Design (`stream<T>`)](https://github.com/WebAssembly/component-model/blob/main/design/mvp/Async.md):
  The specification defining unbuffered, rendezvous stream ABIs across component boundaries.
- [WHATWG Streams Standard: BYOB Readers](https://streams.spec.whatwg.org/#byob-readers):
  The web standard for Bring Your Own Buffer readers that avoid per-chunk heap allocation.
- [Cloudflare: A Better Web Streams API](https://blog.cloudflare.com/a-better-web-streams-api/):
  Analysis of memory cliffs, per-element promise allocations, and unbounded buffering in streams.
- [Wikipedia: Synchronous Channels](<https://en.wikipedia.org/wiki/Channel_(programming)#Synchronous_channels>):
  The Communicating Sequential Processes (CSP) foundation for zero-capacity rendezvous channels.
