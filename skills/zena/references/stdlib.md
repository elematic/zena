# The standard library

A map of the libraries, for finding the one to look up. It is not an API
reference: signatures are at `https://zena-lang.dev/api/<library>/`.

Import with `import {name} from 'zena:<library>';`. Search here before
writing a helper. A library marked "component" needs a WASI host (`zena
run`, or a `component` build); one marked "host" needs the `zena` runtime.

## The prelude

Available in every library without an import:

`String`, `Error`, `IndexOutOfBoundsError`, `Option`, `Some`, `None`,
`some`, `none`, `Array`, `MutableArray`, `GrowableArray`, `FixedArray`,
`ImmutableArray`, `Map`, `Box`, `Future`, `Iterable`, `Iterator`, the range
classes (`Range`, `BoundedRange`, `FromRange`, `ToRange`, `FullRange`) and
`console`.

`new Map<K, V>()` builds a `HashMap`, and `new Array<T>()` a
`GrowableArray`.

## Language support

| Library            | What it holds                                                                                                                                                                                                             |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `zena:core`        | What the prelude does not bind: `fixed`, `growable`, `StringBuilder`, `StringReader`, `StringIndex`, `ByteBuffer`, `IterableUtils`, `Disposable`, `Own`, `Borrow`, `Resource`, `Scoped`, `Result`, `parseI32`, `parseI64` |
| `zena:collections` | `HashMap`, `OrderedHashMap`, `HashSet`, `OrderedHashSet`, `Set`, `MapEntry`, `Hashable`, `zip`                                                                                                                            |
| `zena:string`      | `join`, `dedent`, `StringTable`, and ASCII and Unicode character tests (`isAsciiDigit`, `isUnicodeWhitespace`)                                                                                                            |
| `zena:math`        | `div` (integer division), `min`, `max`, `abs`, `sqrt`, `floor`, `ceil`, the libm functions (`sin`, `pow`, `log`, …), `PI`, integer limits, `clz`/`ctz`/`popcnt`, 128-bit arithmetic                                       |
| `zena:bigint`      | `BigInt`. A literal with an `n` suffix is one                                                                                                                                                                             |
| `zena:decimal`     | `Decimal` (IEEE decimal128), `RoundingMode`, `DecimalContext`. Use for money                                                                                                                                              |
| `zena:simd`        | `v128` shapes (`F32x4`, `I32x4`, …) with elementwise operators, and every WebAssembly SIMD instruction                                                                                                                    |
| `zena:memory`      | Linear memory: `Memory`, `Allocator`, `BumpAllocator`                                                                                                                                                                     |

## Async

| Library        | What it holds                                                                                                                   |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `zena:async`   | `Future`, `Completer`, `TaskGroup`, `CancelScope`, `currentScope`, `checkCancellation`, `AsyncIterator`, `AsyncIterable`        |
| `zena:task`    | Policies over an operation `() => Future<T>`: `timeout`, `deadline`, `retry`, `fallback`, `hedge`; `Task` with observable state |
| `zena:stream`  | `Stream<T>` and `StreamWriter<T>` with backpressure, `readAllBytes`, `readAllText`, `Multicast`                                 |
| `zena:time`    | `sleep`, `monotonic`, `Instant`, `Duration`, `milliseconds`                                                                     |
| `zena:signals` | `State`, `Computed`, `effect`, `batch`, `Watcher`: the TC39 signals proposal                                                    |

## Data and text

| Library         | What it holds                                                                          |
| :-------------- | :------------------------------------------------------------------------------------- |
| `zena:json`     | `parseJson`, `stringify`, `JsonObject`, `JsonArray`, `JsonBuilder`, `jsonGet`          |
| `zena:regex`    | `Regex` and the `` regex`…` `` tag. Linear time: no backreferences or lookaround       |
| `zena:encoding` | `hex`, `base32`, `base64`, `base64Url`, `isValidUtf8`                                  |
| `zena:crypto`   | SHA-256, HMAC, HKDF, ECDSA on P-256 and secp256k1                                      |
| `zena:random`   | `randomBytes`, `randomInt`, `randomF64`, `randomU64`, from the host's secure generator |
| `zena:url`      | `URL`, `URLSearchParams`, `URLPattern`, percent-encoding                               |
| `zena:path`     | `join`, `dirname`, `basename`, `extname`, `normalize`, `relative`                      |
| `zena:glob`     | `matchGlob`, `GlobPattern`, `GlobSet`                                                  |

## Programs and hosts

| Library                                   | Needs                | What it holds                                                                                                  |
| :---------------------------------------- | :------------------- | :------------------------------------------------------------------------------------------------------------- |
| `zena:cli`                                | component            | `getArguments`, `getEnv`, `readStdin`, `exit`, `initialCwd`                                                    |
| `zena:args`                               |                      | `ArgParser`: flags, typed options, subcommands, `--help` text                                                  |
| `zena:fs`                                 | component            | `readFile`, `writeFile`, `readFileBytes`, `listDir`, `exists`, `mkdir`, `stat`, `glob`. All async              |
| `zena:fetch`                              | component, `zena-js` | `fetch(url, init)` and `Response`                                                                              |
| `zena:http`                               |                      | An HTTP server framework over `wasi:http`: `App`, `Router`, `Request`, `Response`, middleware, `cors`, `serve` |
| `zena:process`                            | host                 | `spawn`, `run`, signals. Needs `zena run --allow-spawn`                                                        |
| `zena:wasm`                               | host                 | Run another Wasm module: `runModule`                                                                           |
| `zena:extensions`                         | host                 | Load components as extensions of the running program                                                           |
| `zena:js`                                 | `zena-js`            | Bridge futures to and from JavaScript promises                                                                 |
| `zena:web-templates`, `zena:web-elements` |                      | `html` templates and custom elements in the shape of Lit                                                       |

## Testing

| Library       | What it holds                                                                                                                                     |
| :------------ | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `zena:test`   | `suite`, `test`, `testOnly`, `testSkip`                                                                                                           |
| `zena:assert` | `equal`, `notEqual`, `same`, `isTrue`, `isFalse`, `isNull`, `isNotNull`, `greater`, `less`, `throws`, `rejects`, `equalText`, `jsonEqual`, `fail` |
| `zena:bench`  | A sampling benchmark runner, used by `zena bench`                                                                                                 |

## Looking up an API

- `https://zena-lang.dev/api/<library>/`, for example
  `https://zena-lang.dev/api/collections/`.
- In a checkout of `https://github.com/elematic/zena`, the sources are in
  `packages/stdlib/zena/`. Each library opens with a doc comment and
  examples.
- For a package that is not the standard library:

  ```sh
  zena doc path/to/package | jq -r '.modules[].declarations[].signature'
  ```

  Each declaration also carries its doc comment (`.doc.description`) and its
  members.
