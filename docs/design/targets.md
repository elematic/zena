# Compilation Targets in Zena

This document describes the compilation targets supported by the Zena compiler,
comparing their module representations, standard library virtualization, host
boundary contracts, binary sizes, and test coverage across the repository.

---

## 1. Overview

A compilation target in Zena defines:

1. **Module Kind**: A core WebAssembly GC module (`wasm32`) or a WebAssembly
   Component (Component Model).
2. **String Strategy**: Native JavaScript string handles (`wasm:js-string`)
   for `js`, or WebAssembly GC `ByteArray`-backed UTF-8 views for all other targets
   (`freestanding`, `component`, `zena-cli`). In component targets, linear memory
   is only used at external component boundary crossings when lowered/lifted by
   the Canonical ABI.
3. **Standard Library Resolution**: Which physical library files back virtual
   module specifiers (`core/string.zena`, `zena:console`, `zena:error-stack`,
   `zena:time`, `zena:fs`). `zena:core` itself is a normal library with a single
   shared entry point (`core/index.zena`), minimizing checker divergence across targets.
4. **Host Contract**: What imports the host must provide at instantiation time,
   and what runtime helpers the guest module exports.

The target is set per compilation via `--target <name>` (or `-t <name>`) on
`zena build`. The canonical target resolver lives in
[`packages/zena-compiler/zena/lib/targets.zena`](file:///Users/justin/Projects/Zena/zena/packages/zena-compiler/zena/lib/targets.zena).

---

## 2. Target Comparison Matrix

| Target                     | Alias  | Module Kind  | String Representation                                                     | Virtualized Standard Library                                                              | Intended Host Environment                                                      |
| :------------------------- | :----- | :----------- | :------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| **`js`**                   | `host` | Core Wasm-GC | Wasm GC `String` class wrapping `#handle: externref` via `wasm:js-string` | `core/string-js.zena`, `console/js.zena`, `core/error/stack-host.zena`                    | Web browsers, Node.js, `@zena-lang/runtime`                                    |
| **`freestanding`**         | —      | Core Wasm-GC | Wasm GC `String` class wrapping UTF-8 `ByteArray` views                   | `core/string.zena`, `console/component.zena`                                              | Bare WebAssembly GC runtimes, micro-benchmarks, embedders with no host imports |
| **`component`**            | —      | Component    | Wasm GC `String` class wrapping UTF-8 `ByteArray` views                   | `core/string.zena`, `console/component.zena`, `time/component.zena`, `fs/component.zena`  | Standard WASI Preview 2 / Preview 3 runtimes, Wasmtime, `jco`                  |
| **`zena-cli`** _(default)_ | —      | Component    | Wasm GC `String` class wrapping UTF-8 `ByteArray` views                   | `core/string.zena`, `console/component.zena`, `cli/component.zena`, `time/component.zena` | `zena-cli` and `zena-run` (Rust/wasmtime host embedding `zena-cli:host` WIT)   |

---

## 3. Target Specifications & Host Contracts

### A. JavaScript Target (`--target js`, alias `host`)

The `js` target is optimized for execution inside JavaScript engines
(V8/Node.js, JavaScriptCore/Bun/Safari, SpiderMonkey/Firefox).

#### String Architecture

- Rather than embedding a UTF-8/UTF-16 transcoder or linear memory allocator,
  `String` compiles as a standard WebAssembly GC class backed by a native
  JavaScript string handle:
  ```zena
  export final class String implements Hashable {
    #handle: externref;
    new #fromHandle(handle: externref) : #handle = handle;
    handle: externref { get { return this.#handle; } }
    length: i32 { get { return __js_string_length(this.#handle); } }
  }
  ```
- Operations (`concat`, `substring`, `equals`, `compare`, `charCodeAt`,
  `fromCharCode`, etc.) delegate to the **WebAssembly JS String Builtins
  proposal** under import module `"wasm:js-string"`.
- String literals in source code do not emit data segments. Instead, the
  compiler emits imported string constants under module name `"_"`:
  ```wat
  (import "_" "Hello, World!" (global $raw_str (ref extern)))
  ```
  In `$__start`, literals are wrapped once into GC `String` instances and cached
  in globals.

#### Host Requirements

A host executing a `--target js` module must supply:

1. **`wasm:js-string` builtins**: Native string imports (`length`, `concat`,
   `equals`, `compare`, `substring`, `charCodeAt`, `codePointAt`,
   `fromCharCode`, `fromCodePoint`). When running in JavaScript engines without
   native support,
   [`@zena-lang/runtime`](file:///Users/justin/Projects/Zena/zena/packages/runtime/src/index.ts)
   provides default fallback implementations.
2. **String constants module (`"_"`)**: The loader inspects module imports from
   `"_"` and supplies matching JavaScript string handles.
3. **Console import (`"console"`)**: When `console.log(...)` is reachable, the
   module imports `@external("console", "log_string")` taking an `externref`.
4. **Runtime helpers exported by guest**: The module exports three helper
   functions for host interop:
   - `$stringCreate(handle: externref): (ref $String)`: Wraps a host JS string
     into a Zena `String`.
   - `$stringGetHandle(s: (ref $String)): externref`: Unwraps a Zena `String` to
     its host JS string handle.
   - `$stringGetLength(s: (ref $String)): i32`: Returns the length in UTF-16
     code units.

---

### B. Freestanding Target (`--target freestanding`)

The `freestanding` target produces a minimal core WebAssembly GC module with
zero host imports beyond user-declared `@external` functions.

#### Characteristics

- `String` is backed by a WebAssembly GC `ByteArray` (`(array (mut i8))`)
  storing UTF-8 bytes with `#start` and `#end` offsets.
- String literals are emitted as data segments and initialized in `$__start`.
- No standard I/O, filesystem, process, or timer imports are included.
- Used for cross-language benchmarks (comparing Zena directly against
  AssemblyScript `-O3z` and Rust `no_std`), embedded Wasm runtimes without host
  facilities, or pure compute modules.

---

### C. Standard Component Target (`--target component`)

The `component` target packages the program into a WebAssembly Component
following the Component Model specification.

#### Characteristics

- Internally, strings use the standard WebAssembly GC `ByteArray` representation.
- Types crossing external component boundaries are lowered and lifted via the Component
  Model Canonical ABI (allocating into linear memory via `cabi_realloc`).
- Targets standard WASI Preview 2 / Preview 3 interfaces (`wasi:cli`, `wasi:io`,
  `wasi:clocks`, `wasi:filesystem`).
- Can be inspected using `wasm-tools component wit` and run in any standard
  component host.

---

### D. CLI Target (`--target zena-cli`, default)

The default target for the `zena` compiler CLI. It produces a WebAssembly
Component tailored for `zena-cli` and `zena-run`.

#### Characteristics

- Links in WASI 0.3 plus the custom `zena-cli:host` WIT interfaces
  ([`packages/stdlib/zena/host-wit/host.wit`](file:///Users/justin/Projects/Zena/zena/packages/stdlib/zena/host-wit/host.wit)):
  - `zena-cli:host/stack-trace`: Native stack trace extraction for `Error`.
  - `zena-cli:host/process`: Process spawning (`zena:process`).
  - `zena-cli:host/wasm`: Dynamic in-process WebAssembly module execution
    (`zena:wasm`).
- Powers all command-line tools (`zena`, `zb`, `zenadoc`, `zena-formatter`).

---

## 4. Module Size & Overhead Comparison

Measurements taken with `-O2` optimization across identical source workloads:

| Workload           | Source                                                           | `--target js` | `--target freestanding` | `--target component` | `--target zena-cli` |
| :----------------- | :--------------------------------------------------------------- | :-----------: | :---------------------: | :------------------: | :-----------------: |
| **`minimal`**      | `export function main(): i32 { return 42; }`                     |   **37 B**    |        **37 B**         |         92 B         |       6.9 KB        |
| **`hello-world`**  | `export function main(): String { return "Hello World"; }`       |   **224 B**   |        **326 B**        |        3.4 KB        |       7.3 KB        |
| **`console-main`** | `export function main(): void { console.log("Hello, World!"); }` |   **275 B**   |     _N/A (no I/O)_      |        6.6 KB        |       8.3 KB        |

### Analysis of Trade-offs

1. **Zero-overhead baseline**: For programs without string allocations or I/O,
   both `freestanding` and `js` produce identical 37-byte modules (1 type, 1
   function, 1 export).
2. **String handling efficiency**: For string-heavy programs, `--target js`
   produces the smallest binaries because string literals are imported rather
   than encoded as UTF-8 data segments with Wasm array initialization loops.
3. **Component Model boundary tax**: Components (`component` and `zena-cli`)
   carry a baseline overhead of 3KB–7KB due to the canonical ABI adapter
   sections, memory allocator (`cabi_realloc`), and WASI Preview 2/3 stream
   wrappers.

---

## 5. Testing Strategy & Coverage

Each compilation target is validated through dedicated test suites across the
monorepo:

### A. Testing `--target js`

1. **Portable Semantics Suite**
   ([`packages/zena-compiler/zena/test/portable_semantics.zena`](file:///Users/justin/Projects/Zena/zena/packages/zena-compiler/zena/test/portable_semantics.zena)):
   - **All 614 semantics tests** in `tests/language/semantics/` are compiled
     with `target: 'js'`, verifying parsing, type checking, and scope analysis
     against the JS target prelude and standard library.
2. **Runtime Test Suite**
   ([`packages/runtime/src/test/`](file:///Users/justin/Projects/Zena/zena/packages/runtime/src/test/)):
   - `js_strings_test.ts`: Directly tests string operations under
     `wasm:js-string` (concatenation, slicing, case conversions, comparisons,
     equality, splitting).
   - `console_test.ts`: Verifies direct string handle logging and reader
     fallbacks.
   - `string_writer_test.ts`: Tests host-to-Wasm string transfers via
     `$stringCreate`.
   - `time_test.ts` & `to_promise_test.ts`: Tests JS event loop parking and
     `Promise` interop.
3. **Language Service & In-Memory Compiler**
   ([`packages/language-service/`](file:///Users/justin/Projects/Zena/zena/packages/language-service/)):
   - `lsp.wasm` is built using `zena-cli build zena/lsp.zena --target host -o
lsp.wasm`.
   - All language service tests (`packages/language-service/test/lsp_test.js`)
     execute this module in Node.js.
   - `packages/runtime/src/test/compile-zena.ts` runs `lsp.wasm` in-memory to
     compile test cases.
4. **Compiler Subsystem Tests**:
   - `multi-target_test.zena`: Tests resolver caching and library isolation for
     `target: 'js'`.
   - `virtual-library_test.zena`: Asserts public API signatures of virtual
     modules for `target: 'js'`.
   - `codegen-wat_test.zena`: Verifies WAT emission for JS console imports and
     string globals.
   - `external-functions-test.ts`: End-to-end Node.js tests compiling with `-t
js` and `-t host`.

### B. Testing `--target zena-cli`

1. **Portable Execution Suite**
   ([`packages/zena-compiler/zena/test/portable_execution.zena`](file:///Users/justin/Projects/Zena/zena/packages/zena-compiler/zena/test/portable_execution.zena)):
   - Compiles every execution test under `tests/language/execution/` with
     `target: 'zena-cli'` and executes it via `zena-cli run` on Wasmtime.
2. **Standard Library Test Suite**
   ([`packages/stdlib/tests/`](file:///Users/justin/Projects/Zena/zena/packages/stdlib/tests/)):
   - Runs under `zena-cli test tests`, exercising CLI and WASI capabilities
     (filesystem, environment, regex, collections, async).
3. **CLI & Tooling Tests**:
   - Compiler self-hosting and fixpoint parity check (`npm run test:fixpoint`).

### C. Testing `--target freestanding`

1. **Cross-Language Benchmarks**
   ([`benchmarks/zena/build.zena`](file:///Users/justin/Projects/Zena/zena/benchmarks/zena/build.zena)):
   - All 15 workloads in `benchmarks/workloads/` compile with `-O2 --target
freestanding` and run size/speed benchmarks.
2. **Unit Tests**:
   - `external-functions-test.ts` verifies standalone module instantiation with
     minimal host imports.
   - Multi-target unit tests verify clean emission without host scaffold.

### D. Testing `--target component`

1. **Component E2E Suite**
   ([`packages/zena-compiler/src/scripts/component-e2e.ts`](file:///Users/justin/Projects/Zena/zena/packages/zena-compiler/src/scripts/component-e2e.ts)):
   - Tests WIT world synthesis, component encoding, and execution in Wasmtime.
2. **Multi-Target Suite**
   ([`multi-target_test.zena`](file:///Users/justin/Projects/Zena/zena/packages/zena-compiler/zena/test/multi-target_test.zena)):
   - Validates virtual module resolution (`zena:console` ->
     `console/component.zena`).
