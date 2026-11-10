---
title: 'Compile Targets'
description: 'Reference for Zena compile targets, capability flags, host contracts, and standard library availability.'
---

Selected via `--target <name>` or `-t <name>` on `zena build`. When `--target`
is omitted, the compiler uses `zena-component`.

## Target matrix and capability flags

Each target name maps to a fixed `TargetFeatures` record in the compiler:

| Target           | Output format | `component` | `jsStrings` | `wasi`  | `zenaJsHost` | `zenaComponentHost` |
| :--------------- | :------------ | :---------: | :---------: | :-----: | :----------: | :-----------------: |
| `core`           | Core Wasm GC  |   `false`   |   `false`   | `false` |   `false`    |       `false`       |
| `js`             | Core Wasm GC  |   `false`   |   `true`    | `false` |   `false`    |       `false`       |
| `zena-js`        | Core Wasm GC  |   `false`   |   `true`    | `false` |    `true`    |       `false`       |
| `component`      | Component     |   `true`    |   `false`   | `true`  |   `false`    |       `false`       |
| `zena-component` | Component     |   `true`    |   `false`   | `true`  |   `false`    |       `true`        |

Required WebAssembly proposals across all targets:

- **GC**, **Typed Function References**, **Exception Handling** (`exnref`),
  **Tail Calls**, and **Fixed-Width SIMD**.
- **JS String Builtins** (`wasm:js-string` + `importedStringConstants`) on
  targets with `jsStrings` (`js`, `zena-js`).
- **Component Model** with the **Async Canonical ABI** on targets with
  `component` (`component`, `zena-component`).

## core

Emits a core WebAssembly GC module with no implicit host imports.

- **Strings**: UTF-8/WTF-8 slices over GC `ByteArray` (`(array (mut i8))`).
  String literals are stored in a passive data segment and initialized once.
- **Prelude**: Core language types (`String`, `Error`, `Option`, array and range
  types, `Map`, `Box`). `console` is excluded from the prelude.
- **Host imports**: None, unless the program declares `@external("module",
"name")` functions.
- **Boundary helpers**: When `String` crosses an exported or `@external`
  function signature, the compiler exports byte-transfer helpers as needed
  (`$stringGetLength`, `$stringGetByte`, `$stringCreate`, `$stringSetByte`).

## js

Emits a core WebAssembly GC module for JavaScript engines with JS String
Builtins, requiring zero `@zena-lang/runtime` imports.

- **Instantiation**:
  ```js
  WebAssembly.instantiate(
    bytes,
    {},
    {
      builtins: ['js-string'],
      importedStringConstants: '_',
    },
  );
  ```
- **Strings**: `String` wraps `#handle: externref`. Core operations lower to
  `wasm:js-string` imports (`length`, `charCodeAt`, `codePointAt`,
  `fromCharCode`, `fromCodePoint`, `concat`, `substring`, `equals`, `compare`).
  Literals import `(global (ref extern))` from `"_"` (or the module set by
  `--imported-string-constants`).
- **Pure-Wasm operations**: `String.indexOf`, `String.replaceAll`,
  `String.toLowerCase`, and `String.toUpperCase` execute in Wasm
  (`core/string-js-pure.zena`). Number formatting/parsing and `zena:url` also
  compile to pure Wasm.
- **Console and stack traces**: `console` is bound in the prelude to a no-op
  implementation (`console/none.zena`), and `Error` stack traces return `null`
  (`stack-none.zena`).
- **Boundary helpers**: Exports `$stringCreate(externref) -> (ref $String)`,
  `$stringGetHandle((ref $String)) -> externref`, and
  `$stringGetLength((ref $String)) -> i32` when `String` crosses module
  boundaries.

## zena-js

Emits a core WebAssembly GC module for JavaScript hosts running
`@zena-lang/runtime`. Enables `jsStrings` and `zenaJsHost`.

- **Instantiation**: `instantiate(bytes, options)` or `createImports(options)`
  from `@zena-lang/runtime`.
- **Host imports** (emitted only when reachable):
  - `wasm:js-string` and imported string constants (`"_"` by default).
  - `zena:host:string`: `indexOf`, `replaceAll`, `toLowerCase`, `toUpperCase`.
  - `zena:host:number`: `String`, `toPrecision`, `parseFloat`.
  - `zena:host:url`: `parse`, `get_<prop>`, `set_<prop>` over host WHATWG `URL`.
  - `zena:host:random`: `u32` backed by `crypto.getRandomValues`.
  - `console`: `log_string`, `error_string`, `warn_string`, `info_string`,
    `debug_string`, `log_i32`, `log_f32`.
  - `env`: `captureStackTrace`, `formatStackTrace` for lazy `Error` stack
    traces.
  - `time`: `now_ms`, `sleep_ms`, `sleep_cancel` (`zena:time`).
  - `js`: `Promise` and host-async settlement hooks (`zena:js`).
  - `web`: `fetch` (`zena:fetch`, opt-in via `{fetch: true}`).

## component

Emits a portable WebAssembly Component. Enables `component` and `wasi`.

- **Strings and memory**: Uses GC `ByteArray` WTF-8 strings internally. Embeds a
  synthesized runtime memory core module (`cabi_realloc`) as the component's
  first core module for Canonical ABI lowering and lifting.
- **WIT worlds**: Without `--wit`, synthesizes a world from the WASI 0.3
  interfaces the program reaches and exports `main` (if present). With `--wit`
  (and optional `--world`), validates exports and imports against the specified
  WIT world.
- **Host imports**: Standard WASI 0.3 interfaces (`wasi:cli@0.3.0`,
  `wasi:filesystem@0.3.0`, `wasi:clocks@0.3.0`, `wasi:random@0.3.0`,
  `wasi:http@0.3.0`) plus any imports from user WIT packages.
- **Execution**: `wasmtime run -S p3=y out.wasm`, `zena-run out.wasm`, or
  `zena run out.wasm`.

## zena-component

Default target. Emits a WebAssembly Component for `zena-runtime` (`zena-cli`,
`zena-run`, and Rust `wasmtime` embedders). Enables `component`, `wasi`, and
`zenaComponentHost`.

- **Host imports**: Everything in `component`, plus reachable interfaces from
  `zena:host@1.0.0` (`packages/stdlib/zena/host-wit/host.wit`):
  - `zena:host/stack-trace@1.0.0`: Wasm backtrace capture on `Error`.
  - `zena:host/process@1.0.0`: Host process spawning (`zena:process`; requires
    `--allow-spawn` or `ZENA_ALLOW_SPAWN=1` at run time).
  - `zena:host/wasm@1.0.0`: In-process execution and `.cwasm` precompilation of
    components and core modules (`zena:wasm`; requires `--allow-spawn`).
  - `zena:host/extensions@1.0.0`: Dynamic component extensions
    (`zena:extensions`; requires `--allow-extensions` or
    `ZENA_ALLOW_EXTENSIONS=1`).
  - `zena:host/http-server@1.0.0`: HTTP/1.1 server (`zena:http`).

## Standard library availability

Portable standard library modules (`zena:core`, `zena:collections`, `zena:math`,
`zena:bigint`, `zena:decimal`, `zena:json`, `zena:regex`, `zena:path`,
`zena:args`, `zena:encoding`, `zena:crypto`, `zena:simd`, `zena:stream`,
`zena:task`, `zena:async`, `zena:signals`, `zena:assert`, `zena:url`) are
available on all five targets. Modules that depend on host capabilities resolve
per target:

| Library              |  `core`   |   `js`    |   `zena-js`    |         `component`          |              `zena-component`              |
| :------------------- | :-------: | :-------: | :------------: | :--------------------------: | :----------------------------------------: |
| `zena:console`       |     —     |   No-op   |    Host JS     |           WASI 0.3           |                  WASI 0.3                  |
| `zena:memory`        | Free-list | Free-list |   Free-list    |          Component           |                 Component                  |
| `zena:web-templates` |  Server   |    DOM    |      DOM       |            Server            |                   Server                   |
| `zena:web-elements`  |  Server   |    DOM    |      DOM       |            Server            |                   Server                   |
| `zena:time`          |     —     |     —     |  Host timers   |         WASI clocks          |                WASI clocks                 |
| `zena:random`        |     —     |     —     |   Web Crypto   |         WASI random          |                WASI random                 |
| `zena:fetch`         |     —     |     —     |  Host `fetch`  |          WASI HTTP           |                 WASI HTTP                  |
| `zena:js`            |     —     |     —     | Host `Promise` |              —               |                     —                      |
| `zena:cli`           |     —     |     —     |       —        |           WASI CLI           |                  WASI CLI                  |
| `zena:fs`            |     —     |     —     |       —        |           WASI FS            |                  WASI FS                   |
| `zena:wasi`          |     —     |     —     |       —        |           WASI 0.3           |                  WASI 0.3                  |
| `zena:http` (server) |     —     |     —     |       —        | WASI HTTP (`zena:http/wasi`) | `zena:host/http-server` + `zena:http/wasi` |
| `zena:process`       |     —     |     —     |       —        |              —               |            `zena:host/process`             |
| `zena:wasm`          |     —     |     —     |       —        |              —               |              `zena:host/wasm`              |
| `zena:extensions`    |     —     |     —     |       —        |              —               |           `zena:host/extensions`           |

Packages can define their own target-conditional libraries in `zena-package.json`
using `"virtual"` export maps keyed by `"core"`, `"js"`, `"zena-js"`,
`"component"`, and `"zena-component"`.

## Target-dependent compiler flags

- **`--wit <path>`**, **`--world <name>`**, **`--extension-wit <path>`**: Valid
  only on targets with `component` (`component`, `zena-component`). Rejected on
  `core`, `js`, and `zena-js`.
- **`--imported-string-constants <module>`**: Sets the import module name for
  string literal globals (default `_`; WebAssembly ESM integration uses
  `wasm:js/string-constants`). Valid only on targets with `jsStrings` (`js`,
  `zena-js`).
- **`--compact-imports`**: Encodes core module imports using the compact import
  section proposal. Valid only on core module targets (`core`, `js`, `zena-js`);
  rejected on `component` and `zena-component`.
