---
title: 'Compile Targets'
description: 'Choosing between core, js, zena-js, component, and zena-component when compiling Zena to WebAssembly.'
---

`zena build` compiles Zena source into either a core WebAssembly GC module or a
WebAssembly Component. Pass `--target <name>` (or `-t <name>`) to select the
target environment; when omitted, `zena build` defaults to `zena-component`.

## The five targets

Zena organizes its compilation targets around three base WebAssembly environments
— bare core Wasm (`core`), JavaScript engines (`js`), and the WebAssembly
Component Model (`component`) — plus Zena-hosted variants (`zena-js` and
`zena-component`) that add host runtime imports:

| Target           | Output format | Intended host                                                                   |
| :--------------- | :------------ | :------------------------------------------------------------------------------ |
| `core`           | Core Wasm GC  | Standalone Wasm GC engines and embedders with no host runtime                   |
| `js`             | Core Wasm GC  | Any JS engine supporting `wasm:js-string` (`WebAssembly.instantiate` with `{}`) |
| `zena-js`        | Core Wasm GC  | Browsers, Node.js, Deno, Bun, or Workers with `@zena-lang/runtime`              |
| `component`      | Component     | Standard WASI 0.3 hosts (`wasmtime run -S p3=y`) and custom WIT worlds          |
| `zena-component` | Component     | `zena-cli`, `zena-run`, and Rust embedders linking `zena-runtime`               |

## Capabilities per target

Each `--target` name selects a fixed combination of five compiler capabilities:

| Capability          | `core` | `js` | `zena-js` | `component` | `zena-component` |
| :------------------ | :----: | :--: | :-------: | :---------: | :--------------: |
| `component`         |   —    |  —   |     —     |     Yes     |       Yes        |
| `jsStrings`         |   —    | Yes  |    Yes    |      —      |        —         |
| `wasi`              |   —    |  —   |     —     |     Yes     |       Yes        |
| `zenaJsHost`        |   —    |  —   |    Yes    |      —      |        —         |
| `zenaComponentHost` |   —    |  —   |     —     |      —      |       Yes        |

- **`component`**: Wraps the program in a WebAssembly Component with Canonical
  ABI adapters at external WIT boundaries.
- **`jsStrings`**: Represents `String` as an `externref` JS string handle using
  the WebAssembly JS String Builtins proposal (`wasm:js-string`) and imported
  string constants. Targets without `jsStrings` store strings as WTF-8 slices of
  a Wasm GC `ByteArray`.
- **`wasi`**: Provides WASI 0.3 standard library modules (`zena:fs`, `zena:cli`,
  `zena:time`, `zena:random`, `zena:fetch`, `zena:console`).
- **`zenaJsHost`**: Enables `@zena-lang/runtime` imports (`console`, `Error`
  stack traces, host `URL` and number conversions, `zena:js`, `zena:time`,
  `zena:random`, `zena:fetch`).
- **`zenaComponentHost`**: Enables the `zena:host@1.0.0` WIT interfaces supplied
  by the Rust `zena-runtime` crate (`Error` stack traces, `zena:process`,
  `zena:wasm`, `zena:extensions`, and inbound `zena:http` servers).

## core

`core` emits a standalone WebAssembly GC module with zero implicit host imports.
Only `@external` declarations written in your own code appear in the Wasm import
section.

```bash
zena build math.zena -o math.wasm --target core
```

Strings use Zena's GC `ByteArray` representation, string literals live in a
passive data segment, and `console` is omitted from the prelude. You can run a
`core` module under `zena-run`, `wasmtime`, or any WebAssembly GC engine:

```js
const {instance} = await WebAssembly.instantiate(bytes, {});
console.log(instance.exports.add(20, 22));
```

## js and zena-js

Both `js` and `zena-js` target JavaScript engines (browsers, Node.js, Deno, Bun,
Cloudflare Workers). Both represent `String` as a native JavaScript string
handle (`externref`) backed by `wasm:js-string` builtins and imported string
constants, avoiding UTF-8/UTF-16 transcoding across the JS boundary.

### Plain `js` (zero runtime imports)

`--target js` emits a module that instantiates with an empty `{}` import object
on any engine with JS String Builtins enabled:

```bash
zena build lib.zena -o lib.wasm --target js
```

```js
const {instance} = await WebAssembly.instantiate(
  bytes,
  {},
  {builtins: ['js-string'], importedStringConstants: '_'},
);
const name = instance.exports.$stringCreate('world');
const text = instance.exports.$stringGetHandle(instance.exports.greet(name));
```

Numeric exports cross directly; when an exported function takes or returns a
Zena `String` struct, `$stringCreate` and `$stringGetHandle` wrap and unwrap the
underlying JS string handle without copying characters.

On `js`, string search (`indexOf`, `replaceAll`), Unicode case conversion,
number formatting and parsing, and `zena:url` run in pure Wasm, `console` is a
no-op, and `Error` carries no host stack trace. Host-dependent libraries
(`zena:js`, `zena:fetch`, `zena:time`, `zena:random`) are unavailable on `js`.

### `zena-js` (with `@zena-lang/runtime`)

`--target zena-js` targets applications that load the module through
`@zena-lang/runtime`:

```bash
zena build app.zena -o app.wasm --target zena-js
```

```js
import {instantiate} from '@zena-lang/runtime';

const {instance} = await instantiate(bytes);
console.log(instance.exports.greet());
```

`zena-js` delegates `String` case conversion and search, number formatting and
parsing, and `URL` to JavaScript's built-in implementations (shrinking the Wasm
binary), wires `console` and lazy `Error` stack traces to the JS host, and makes
`zena:js`, `zena:time`, `zena:random`, and `zena:fetch` available.

## component and zena-component

Both `component` and `zena-component` emit WebAssembly Components over WASI 0.3.
Inside the component, Zena values live on the Wasm GC heap; linear memory and
`cabi_realloc` are used only when values cross external WIT interfaces.

### `component` (portable WASI 0.3 / WIT worlds)

`--target component` imports only standard WASI 0.3 interfaces (or the WIT world
selected with `--wit` and `--world`), so the resulting binary runs on `wasmtime`
and other standard component runtimes:

```bash
zena build app.zena -o app.wasm --target component
wasmtime run -S p3=y app.wasm
```

### `zena-component` (default)

`--target zena-component` is the default target for `zena build`, `zena run`,
and `zena test`. Alongside WASI 0.3, it links the `zena:host@1.0.0` WIT package
implemented by the Rust `zena-runtime` crate:

```bash
zena build tool.zena -o tool.wasm
zena-run tool.wasm
```

`zena-component` adds Wasm backtrace capture on `Error` plus host capabilities
outside WASI's scope: spawning OS subprocesses (`zena:process`), running child
Wasm modules (`zena:wasm`), loading plugin components (`zena:extensions`), and
serving HTTP (`zena:http`). Process spawning and extensions stay disabled at
runtime unless granted with `--allow-spawn` or `--allow-extensions`.

## Choosing a target

- Building a CLI tool, server, or script run with `zena run` or `zena-run`, or
  embedding Zena in a Rust host via `zena-runtime`: use **`zena-component`**
  (the default).
- Shipping a portable WASI 0.3 component or targeting a custom WIT world for
  `wasmtime` or another component host: use **`component`**.
- Building a web or Node.js application using `@zena-lang/runtime`, `console`,
  `fetch`, timers, or JS `Promise` interop: use **`zena-js`**.
- Publishing a self-contained `.wasm` library for JavaScript callers with zero
  npm runtime dependencies: use **`js`**.
- Embedding pure compute in a core Wasm GC engine with no JS engine and no
  Component Model host: use **`core`**.

See the [Compile Targets reference](/reference/compile-targets/) for the full
import/export contract and standard library matrix for each target.
