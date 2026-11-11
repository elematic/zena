# Compilation Targets in Zena

This document describes Zena's five compilation targets, the capability flags
each target enables, their standard library resolution, host contracts, binary
sizes, and test coverage across the repository.

---

## 1. Overview

`zena build` selects a compilation target with `--target <name>` (or `-t
<name>`). The five targets organize into three base WebAssembly environments,
with Zena-hosted variants for JavaScript and the Component Model:

| Target                         | Module Kind  | String Representation                                     | Host Runtime                            |
| :----------------------------- | :----------- | :-------------------------------------------------------- | :-------------------------------------- |
| **`core`**                     | Core Wasm GC | UTF-8/WTF-8 `ByteArray` views                             | Any core Wasm GC engine (no imports)    |
| **`js`**                       | Core Wasm GC | `externref` JS string handle (`wasm:js-string`)           | Any JS engine with JS String Builtins   |
| **`zena-js`**                  | Core Wasm GC | `externref` JS string handle (`wasm:js-string`)           | JS engine + `@zena-lang/runtime`        |
| **`component`**                | Component    | UTF-8/WTF-8 `ByteArray` views (lowered via Canonical ABI) | Any WASI 0.3 component host             |
| **`zena-component`** (default) | Component    | UTF-8/WTF-8 `ByteArray` views (lowered via Canonical ABI) | `zena-runtime` (`zena-cli`, `zena-run`) |

Target definitions and capability predicates live in
`packages/zena-compiler/zena/lib/targets.zena`.

---

## 2. Capability Flags (`TargetFeatures`)

Inside the compiler, each `--target` value decomposes into five boolean
capability flags (`TargetFeatures`):

| Flag                | `core`  |  `js`   | `zena-js` | `component` | `zena-component` |
| :------------------ | :-----: | :-----: | :-------: | :---------: | :--------------: |
| `component`         | `false` | `false` |  `false`  |   `true`    |      `true`      |
| `jsStrings`         | `false` | `true`  |  `true`   |   `false`   |     `false`      |
| `wasi`              | `false` | `false` |  `false`  |   `true`    |      `true`      |
| `zenaJsHost`        | `false` | `false` |  `true`   |   `false`   |     `false`      |
| `zenaComponentHost` | `false` | `false` |  `false`  |   `false`   |      `true`      |

What each flag enables:

- **`component`** (`targetEmitsComponent`): Encodes the output as a WebAssembly
  Component with a synthesized runtime memory core module (`cabi_realloc`) and
  Canonical ABI adapters at external world boundaries. Allows `--wit`,
  `--world`, and `--extension-wit`; disallows `--compact-imports`.
- **`jsStrings`** (`targetUsesJsStrings`): Represents `String` as a GC struct
  holding `#handle: externref` (`core/string-js.zena`), emits `wasm:js-string`
  builtin calls, imports string literals as `externref` constants (module `"_"`
  by default, configurable via `--imported-string-constants`), and exports
  `$stringCreate`, `$stringGetHandle`, and `$stringGetLength` when `String`
  crosses module boundaries.
- **`wasi`** (`targetHasWasi`): Resolves WASI 0.3 standard library bindings
  (`zena:console`, `zena:cli`, `zena:fs`, `zena:time`, `zena:random`,
  `zena:fetch`, `zena:http/wasi`, `zena:wasi`) and includes `console` in the
  standard prelude.
- **`zenaJsHost`** (`targetUsesZenaJsHost`): Enables `@zena-lang/runtime` host
  imports (`zena:host:string`, `zena:host:number`, `zena:host:url`,
  `zena:host:random`, `env` stack trace hooks, `console`, `time`, `js`, `web`),
  unlocks `zena:js`, `zena:fetch`, `zena:time`, and `zena:random` on JS, and
  includes `console` in the standard prelude.
- **`zenaComponentHost`** (`targetUsesZenaComponentHost`): Enables the
  `zena:host@1.0.0` WIT package (`packages/stdlib/zena/host-wit/host.wit`)
  implemented by the Rust `zena-runtime` crate, including `stack-trace`,
  `process`, `wasm`, `extensions`, and `http-server`, and links `zena:host-setup`
  into the runtime module list.

---

## 3. Virtualized Standard Library Resolution

`zena:core` has one shared entry library (`core/index.zena`) across all five
targets, keeping prelude type checking consistent while delegating
target-dependent submodules through virtual specifiers in
`packages/stdlib/stdlib-manifest.json`:

| Module                                                 | `core`                       | `js`                          | `zena-js`                     | `component`                  | `zena-component`               |
| :----------------------------------------------------- | :--------------------------- | :---------------------------- | :---------------------------- | :--------------------------- | :----------------------------- |
| `zena:string`                                          | `core/string.zena`           | `core/string-js.zena`         | `core/string-js.zena`         | `core/string.zena`           | `core/string.zena`             |
| `zena:string-js-ops`                                   | —                            | `core/string-js-pure.zena`    | `core/string-js-host.zena`    | —                            | —                              |
| `zena:string-builder`                                  | `core/string-builder.zena`   | `core/string-builder-js.zena` | `core/string-builder-js.zena` | `core/string-builder.zena`   | `core/string-builder.zena`     |
| `zena:number-format`                                   | `core/number-format.zena`    | `core/number-format.zena`     | `core/number-format-js.zena`  | `core/number-format.zena`    | `core/number-format.zena`      |
| `zena:number-parse`                                    | `core/number-parse.zena`     | `core/number-parse.zena`      | `core/number-parse-js.zena`   | `core/number-parse.zena`     | `core/number-parse.zena`       |
| `zena:error-stack`                                     | `core/error/stack-none.zena` | `core/error/stack-none.zena`  | `core/error/stack-host.zena`  | `core/error/stack-none.zena` | `core/error/stack-hooked.zena` |
| `zena:console`                                         | —                            | `console/none.zena`           | `console/js.zena`             | `console/component.zena`     | `console/component.zena`       |
| `zena:memory`                                          | `memory/default.zena`        | `memory/default.zena`         | `memory/default.zena`         | `memory/component.zena`      | `memory/component.zena`        |
| `zena:url` (internal)                                  | `url/url.zena`               | `url/url.zena`                | `url/url-js.zena`             | `url/url.zena`               | `url/url.zena`                 |
| `zena:random`                                          | —                            | —                             | `random/source-js.zena`       | `random/source-wasi.zena`    | `random/source-wasi.zena`      |
| `zena:time`                                            | —                            | —                             | `time/js.zena`                | `time/component.zena`        | `time/component.zena`          |
| `zena:fetch`                                           | —                            | —                             | `fetch/js.zena`               | `fetch/component.zena`       | `fetch/component.zena`         |
| `zena:js`                                              | —                            | —                             | `js.zena`                     | —                            | —                              |
| `zena:cli` / `zena:fs`                                 | —                            | —                             | —                             | `*/component.zena`           | `*/component.zena`             |
| `zena:process` / `wasm` / `extensions` / `http-server` | —                            | —                             | —                             | —                            | `*/component.zena`             |

---

## 4. Target Specifications and Host Contracts

### A. Core Target (`--target core`)

Produces a standalone core WebAssembly GC module with zero implicit host
imports. Only `@external` declarations written in user code produce Wasm import
entries.

- `String` is backed by a GC `ByteArray` (`(array (mut i8))`) storing WTF-8
  bytes with `#start` and `#end` offsets.
- String literals are packed into a passive data segment and initialized once.
- `Error` stack traces are disabled (`stack-none.zena`), and `console` is absent
  from the prelude.
- Used for standalone Wasm GC runtimes, embedded guests, cross-language
  benchmarks (`benchmarks/zena/`), and the synthesized runtime memory core
  module embedded inside component builds.

### B. JavaScript Target (`--target js`)

Produces a core WebAssembly GC module for any JavaScript engine supporting the
JS String Builtins proposal (`wasm:js-string` and `importedStringConstants`),
requiring zero imports from `@zena-lang/runtime`.

```js
const {instance} = await WebAssembly.instantiate(
  bytes,
  {},
  {builtins: ['js-string'], importedStringConstants: '_'},
);
```

- `String` wraps a native JS string handle (`externref`). Basic operations call
  `wasm:js-string` builtins; string search (`indexOf`, `replaceAll`) and Unicode
  case conversion (`toLowerCase`, `toUpperCase`) run in pure Wasm over UTF-16
  code units and embedded case tables (`core/string-js-pure.zena`).
- Number formatting/parsing (`core/number-format.zena`, `core/number-parse.zena`)
  and WHATWG `URL` (`url/url.zena`) use Zena's portable implementations.
- `Error` stack traces use `stack-none.zena`, and `console` resolves to a no-op
  implementation (`console/none.zena`) so portable code calling `console.log`
  compiles and instantiates with an empty `{}` import object.
- Host-dependent libraries (`zena:js`, `zena:fetch`, `zena:time`, `zena:random`)
  are unavailable on `js` and require `zena-js`.

### C. Zena JavaScript Target (`--target zena-js`)

Adds `@zena-lang/runtime` host integration on top of `js`.

- Delegates `indexOf`, `replaceAll`, `toLowerCase`, and `toUpperCase` to host
  JS string methods (`zena:host:string`), number conversions to JS `String`,
  `toPrecision`, and `parseFloat` (`zena:host:number`), and `URL` to host WHATWG
  `URL` (`zena:host:url`), keeping those parsers and tables out of the Wasm
  binary.
- Enables lazy V8/JS `Error` stack traces (`env.captureStackTrace` /
  `env.formatStackTrace`), `console` (`console.log_string`, etc.), `zena:js`
  (`Promise` and host-async interop), `zena:time`, `zena:random`, and
  `zena:fetch`.
- Instantiated with `instantiate(bytes)` or `createImports()` from
  `@zena-lang/runtime`.

### D. Component Target (`--target component`)

Produces a portable WebAssembly Component targeting standard WASI 0.3 worlds or
custom WIT worlds (`--wit`, `--world`).

- Internally uses GC `ByteArray` WTF-8 strings, lowering and lifting across
  component boundaries through the Canonical ABI (`cabi_realloc`).
- Imports only standard WASI 0.3 interfaces (`wasi:cli`, `wasi:filesystem`,
  `wasi:clocks`, `wasi:random`, `wasi:http`) or interfaces declared in the
  selected WIT world.
- Runs directly under `wasmtime run -S p3=y` or any WASI 0.3 component host, as
  well as `zena-run` and `zena-cli run`.

### E. Zena Component Target (`--target zena-component`, default)

Produces a WebAssembly Component targeting WASI 0.3 plus the `zena:host@1.0.0`
WIT interfaces (`packages/stdlib/zena/host-wit/host.wit`) supplied by the Rust
`zena-runtime` crate (`zena-cli`, `zena-run`, or custom Rust embedders):

- `zena:host/stack-trace@1.0.0`: Wasm backtrace capture for `Error`.
- `zena:host/process@1.0.0`: Subprocess spawning (`zena:process`, gated on
  `Grant::spawn` / `--allow-spawn`).
- `zena:host/wasm@1.0.0`: Child component and core module execution and `.cwasm`
  precompilation (`zena:wasm`, gated on `Grant::spawn`).
- `zena:host/extensions@1.0.0`: Long-lived component extensions
  (`zena:extensions`, gated on `Grant::extensions` / `--allow-extensions`).
- `zena:host/http-server@1.0.0`: Inbound HTTP/1.1 server (`zena:http`).

---

## 5. Binary Size Trade-offs

Measured at `-O2` across minimal workloads:

- **Arithmetic-only (`export function main(): i32 { return 42; }`)**: `core`,
  `js`, and `zena-js` emit identical 37-byte core modules (one type, one
  function, one export).
- **String-heavy workloads on JS**: `zena-js` omits Zena's Unicode case tables,
  float formatting/parsing tables, and URL/IDNA tables by calling the JS host;
  `js` links only the portable routines reachable from the program so the module
  runs without `@zena-lang/runtime`.
- **Components (`component` and `zena-component`)**: Include Canonical ABI
  adapters, the runtime memory core module (`cabi_realloc`), and WASI 0.3 stream
  plumbing (~3–8 KB baseline).

---

## 6. Test Coverage

- **`zena-js` & `js` in Node.js**:
  - `packages/zena-compiler/zena/test/portable_semantics.zena` checks all
    `tests/language/semantics/` files against `zena-js`.
  - `packages/language-service/` compiles `lsp.wasm` with `--target zena-js` and
    exposes `compileToWasmForTarget` / `checkForTarget`.
  - `packages/runtime/src/test/` tests `@zena-lang/runtime` imports on `zena-js`
    and zero-import `WebAssembly.instantiate(bytes, {}, ...)` execution on `js`
    (`pure_js_target_test.ts`).
- **`zena-component`**:
  - `packages/zena-compiler/zena/test/portable_execution.zena` compiles and runs
    all `tests/language/execution/` tests with `zena-component`.
  - `packages/stdlib/tests/` and `packages/zena-cli/tests/` exercise WASI 0.3
    and `zena:host@1.0.0` interfaces.
  - `npm run test:fixpoint -w @zena-lang/zena-compiler` verifies Stage B ≡
    Stage C self-hosted compiler parity.
- **`component`**:
  - `packages/zena-compiler/src/scripts/component-e2e.ts` compiles WIT fixtures
    with `--target component` and runs them under `wasmtime`.
- **`core`**:
  - `benchmarks/zena/` compiles all benchmark workloads with `-O2 --target core`.
  - `packages/zena-compiler/src/scripts/external-functions-test.ts` and
    `packages/zena-compiler/zena/test/binary-size_test.zena` verify core module
    imports and binary sizes across `core`, `js`, `zena-js`, `component`, and
    `zena-component`.
