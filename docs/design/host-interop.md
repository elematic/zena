# Host Interop Design

This document outlines the design for interaction between Zena and the host environment (JavaScript/Node.js/Browser).

## Goals

1.  **Imports**: Allow Zena programs to call functions provided by the host.
2.  **Exports**: Allow the host to call functions defined in Zena.
3.  **Data Marshaling**: Define how complex types (Strings, Objects) are passed between Zena and the host.
4.  **Standard Library**: Provide a mechanism for standard library features (like `Console`) to be implemented via host bindings.

## Imports

Zena supports declaring external functions using the `declare` keyword with the `@external` decorator. These declarations map to WebAssembly imports.

### Syntax

```zena
@external("module_name", "function_name")
declare function myFunction(a: i32, b: i32): i32;
```

### Implementation

- The compiler generates a `(import ...)` entry in the WASM binary.
- The type signature must be compatible with WASM types.
- For high-level types (String, Class instances), we need a marshaling strategy (see below).

## Exports

Top-level functions and classes can be exported using the `export` keyword.

```zena
export add = (a: i32, b: i32): i32 => {
  return a + b;
}
```

- **Functions**: Exported directly as WASM exports.
- **Classes**: Not directly exported as a class, but their constructor or factory methods might be.

## Data Marshaling

### CRITICAL: WASM GC Opacity

**WASM GC structs and arrays are OPAQUE from JavaScript.** This is a fundamental limitation of the current WASM GC specification:

- JS cannot read struct fields
- JS cannot iterate over GC arrays
- JS cannot access array elements by index

The only way to exchange complex data between WASM GC and JavaScript is:

1. Through primitive return values (i32, f32, etc.)
2. Through exported WASM functions that JS can call
3. By streaming data byte-by-byte through host function calls

### Strings: V8-Optimized Pattern (Recommended)

Zena strings are implemented as a GC struct wrapping a `ByteArray` (WASM GC `(array i8)`).

```wat
(type $String (struct
  (field $vtable (ref null eq))
  (field $bytes (ref $ByteArray))  ;; (array i8)
  (field $length i32)
))
```

**Problem**: Since WASM GC arrays are opaque, we cannot simply pass a `ByteArray` to JavaScript and have JS iterate over it.

**Solution - V8-Optimized Pattern**: Recommended by the dart2wasm team in https://github.com/WebAssembly/gc/issues/568: pass the string reference as `externref` to the host, then have JavaScript iterate by calling an exported getter function. In the same thread, Jakob Kummerow (V8) notes that V8's Wasm-into-JS inlining only triggers for nullable `externref` in the Wasm signature — not `anyref`, and not typed references — and that an explicit `ref.cast` on the Wasm side is faster than an implicit type check at the boundary. That is why the getter takes `externref` and casts internally.

Zena automatically exports a `$stringGetByte(externref, i32) -> i32` function that allows JavaScript to read individual bytes from a Zena string:

```wat
;; Auto-generated export
(func $stringGetByte (export "$stringGetByte") (param externref i32) (result i32)
  local.get 0
  any.convert_extern        ;; externref -> anyref
  ref.cast $String          ;; anyref -> (ref $String)
  struct.get $String 1      ;; get bytes field
  local.get 1
  array.get_u $ByteArray)   ;; get byte at index
```

Host functions receive the string as `externref` plus its length:

```zena
// In console.zena
@external("console", "log_string")
declare function __console_log_string(s: String, len: i32): void;

// Usage:
__console_log_string(message, message.length);
```

JavaScript iterates using the exported getter:

```javascript
// In @zena-lang/runtime
function createStringReader(exports) {
  const getByte = exports.$stringGetByte;

  return (strRef, length) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      bytes[i] = getByte(strRef, i) & 0xff;
    }
    return new TextDecoder().decode(bytes);
  };
}
```

**Trade-offs**:

- ✅ Works with current WASM GC spec
- ✅ More efficient than byte-streaming (1 host call instead of N+2)
- ✅ JS engine can optimize the loop better than repeated WASM->JS calls
- ✅ No linear memory needed
- ❌ Requires exported getter function in WASM module

The inverse direction works the same way: `createStringWriter` in
`@zena-lang/runtime` builds a Zena string through exported
`$stringCreate`/`$stringSetByte` functions — this is how host-async
string completions (`__zena_complete_string`) deliver their payloads.

**Why this is faster** (per V8 team):

- JS-to-WASM calls are cheaper than WASM-to-JS calls
- JS can inline and optimize the loop
- Avoids creating many short-lived closures in WASM

### Legacy: Byte Streaming (Deprecated)

The previous byte-streaming approach is still supported but not recommended:

```zena
@external("console", "log_string_start")
declare function __console_log_string_start(len: i32): void;

@external("console", "log_string_byte")
declare function __console_log_string_byte(byte: i32): void;

@external("console", "log_string_end")
declare function __console_log_string_end(): void;
```

This makes N+2 host function calls for a string of N bytes, which is slower than the V8-optimized pattern.

**Future Alternatives**:

- **Linear Memory Buffer**: Allocate a shared linear memory region, copy GC data to it, pass pointer/length
- **Type Imports**: When WASM type imports are widely available, JS could understand struct layouts
- **WASM Component Model**: WASI Preview 2 may provide better high-level type support

### Objects / Classes

- **Zena -> Host**: Passed as `externref` or `anyref`. The host holds an opaque reference. To interact with it, the host must call exported Zena methods, passing the reference back.
- **Host -> Zena**: Passed as `externref`. Zena can hold it, but cannot directly access properties.

## Host object handles

Status: **implemented** (2026-08). Host objects cross the boundary as
garbage-collected references instead of registry ids; the generic call
layer that works over those references (next section) is still
planned, and is what removes the remaining per-API runtime JS.

### Registry ids before

`zena:fetch` kept the JS `Response` on the host in a
`Map<number, Response>` and handed Zena an `i32` id;
`response_status(id)` and `response_text(handle, id)` looked it up, and
`Response` implemented `Disposable` solely so an entry whose body was
never read could be released early. The id existed because the async
completion path could only deliver `void`/`i32`/`f64`/`String` payloads
([async.md](async.md) §4, "the closed set of things a JS host can hand
to wasm"): the object could not cross at completion time, so a name for
it crossed instead — and the name brought a registry, a lifetime, and a
disposal obligation with it.

### Anyref handles and the `extern` completion kind

Zena already held host objects directly: `zena:error-stack` keeps a JS
stack handle as `distinct type StackRef = anyref`, received through an
ordinary import return. The JS object lives inside the WasmGC heap
behind `any.convert_extern`, and the engine's unified garbage collector
frees it when the Zena struct that holds it dies.

The missing piece was delivering such a reference _asynchronously_: one
new completion kind, `__zena_complete_extern(handle, ref)`, beside the
four existing ones. A reference-carrying operation registers as
`pending<anyref>()` — one canonical payload type, not one per binding,
because the registry's type check is exact (`Completer<anyref>` is the
tag) and the single `extern` export can name only one payload type. A
binding casts the awaited `anyref` to its own distinct type. With it,
`fetch` completes with the response object itself:

- `Response` holds `distinct type JsResponse = anyref` instead of an
  `i32` id.
- `response_status`/`response_text` take the reference; the host `Map`,
  the id counter, and `response_drop` are deleted.
- The unread-body leak disappears along with `Response`'s reason to
  implement `Disposable`: collection of the Zena struct releases the
  JS object. (`bodyUsed` semantics stay — they are the web's, not
  lifetime bookkeeping.)

Losing the disposal obligation is a property of this target, not of
`Response`. A WASI implementation of fetch holds a genuine WASI handle
that no garbage collector releases, so that entry keeps a release
obligation and is the candidate for the `resource` regime once move
tracking and implicit disposal land ([ownership.md](ownership.md)).
`zena:fetch` is already a virtual module, so the two entries can
differ in lifecycle while sharing the API surface.

One optimization remains open: import and completion signatures still
declare `anyref` (the compiler wraps only single-GC-ref _returns_ in an
externref shim), while V8's wasm-into-JS inlining triggers only for
nullable `externref` (see the Kummerow notes under "Strings" above).
Moving the reference-carrying signatures to nullable `externref` with
conversions inside belongs to the generic layer below, which fixes the
signature shapes anyway.

## Generic JS interop

Status: **planned** (2026-08), after anyref handles. A lowering layer
that lets Zena code reach host objects without per-API runtime code.
Its home module, `zena:js`, already exists — virtual, resolving only
on the JS-hosted targets, and currently holding the host-async
completion registry (the machinery formerly named `zena:host-async`,
which turned out to be JS-specific once WASI p1 parked synchronously
and the component target's futures rode the canonical ABI's
waitables). The selector layer adds to it:

```zena
// zena:js (sketch of the selector layer)
let statusSel = selector('status');
let textSel = selector('text');

let status = js.getI32(response, statusSel);
let text = await js.call0(response, textSel);   // promise-returning
```

Typed stdlib modules like `zena:fetch` remain the public surface; this
layer replaces their hand-written host side, not their API. Proxy
systems like [Comlink](https://github.com/GoogleChromeLabs/comlink)
demonstrate the general shape on the JS side.

### Selectors

Property names are static at their call sites, so a name should cross
the boundary once per name, not once per call — per-call string
marshaling (an exported byte getter plus `TextDecoder`, see "Strings"
above) would otherwise dominate small calls. `selector(name)` interns
the name: the one-time marshal hands the string to the host, the host
appends it to a table and returns the index, and the hot path traffics
in `(externref, i32, …)` only. Selectors are ordinary values held in
module-level `let`s, so interning needs no compiler support.

### String constants from the JS String Builtins proposal

The one-time marshal itself can go: the
[JS String Builtins](https://github.com/WebAssembly/js-string-builtins)
proposal (shipped in current Chrome, Firefox, and Safari as of Safari
26.2) includes **imported string constants** — the module declares

```wat
(import "S" "text" (global (ref extern)))
```

and an embedder compiling with
[`importedStringConstants: "S"`](https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/JavaScript_builtins)
fulfills the import with the import _name itself_ as an engine-interned
JS string constant. Property names then exist as real JS strings from
instantiation, with no byte copying anywhere.

On an engine without the option, the same binary still works with no
new mechanism: the imports are ordinary externref globals, so
`@zena-lang/runtime` enumerates them with
`WebAssembly.Module.imports(module)`, filters to the `"S"` namespace,
and supplies each import's name string as its value. The engine option
adds optimization (the values become constants the compiler can see),
not semantics, so the fallback is exact.

Routing a Zena literal into such an import is the part that needs
compiler support. The requirement is syntactic — the argument must be
a string literal at the call site, a diagnostic otherwise — with no
constant propagation or escape analysis behind it: a name that is not
a literal is what the runtime `selector()` path is for. Two candidate
surfaces, either lowering to a `global.get` of the imported constant:

- an intrinsic — `jsString('text')` — checked the way existing
  intrinsics are;
- a tagged template — ``js`text` `` — reusing syntax that already
  parses, with the tag imported from `zena:js` and recognized by the
  compiler; a template with interpolations fails the same literal
  check.

The tagged template reads better at call sites; the intrinsic is less
special-casing. Undecided until the layer is built.

#### Host strings beyond JS

Nothing in the constants convention is JS-specific: the import
namespace whose names are the values is implementable by any embedder
that can supply a host value as an externref global — a few lines in
wasmtime, wazero, or a JVM embedder, the same shape as the
`Module.imports()` polyfill above. What is JS-specific is only the
engine-side optimization (`importedStringConstants` making them true
constants) and the `wasm:js-string` builtin _functions_. The natural
host string types are immutable in the plausible hosts —
`java.lang.String`, Go's `string`, .NET's `System.String`, Python's
`str` — so a `HostString` handle can be treated as a value everywhere
the pattern applies, and `JsString` is the JS-target instance of it
rather than its own concept. Whether a non-JS host ever wants it is a
question of what its interop layer would call into; the convention
costs nothing to keep target-neutral.

With constants in place, `selector()` takes an already-JS string, so
interning reduces to the allowlist check and a table append. The i32
hot path and the per-selector stubs below are unchanged — an interned
string could key a `Map` directly, but an array index is cheaper and
the stub table has to be built somewhere regardless.

### Allowlist at intern time

Access control attaches to the selector table: the host checks a name
against its allowlist once, when `selector()` is called, not on every
call — and a denied name fails at the line that named it rather than at
some later call site. Per-object restrictions (which _receivers_ a
selector may be used on) stay open; the intern-time check covers the
name dimension only.

### Host-side dispatch and V8 optimization

Three decisions keep the generic layer as optimizable as the
hand-written bindings it replaces:

- **Fixed-arity import families** (`js_call0`, `js_call1`, …) rather
  than one variadic entry point: packing an arguments array and
  spreading it allocates on every call and defeats inlining. The Zena
  side picks the import by arity statically.
- **Nullable `externref` in every signature**, conversions inside — the
  same V8 inlining condition cited under "Strings".
- **One dispatch stub per selector, with the property name written
  into it** (`new Function('r', 'a', 'return r.text(a)')`), dispatched
  as `stubs[sel](ref, arg)`. A single generic `ref[names[sel]](arg)`
  site sees every selector and every receiver shape, so its inline
  cache goes megamorphic. A per-selector stub owns its own inline
  cache, and a given selector overwhelmingly sees one receiver shape
  (`'text'` sees responses), so those caches stay monomorphic.

  The stub must be a _distinct function object per selector_, which is
  why `new Function` and not a closure over the name: V8 keeps at most
  one feedback cell per function literal per native context
  ([feedback-cell.h](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/objects/feedback-cell.h)),
  so every closure created from one `(r, a) => r[name](a)` literal
  shares one feedback vector and the access site goes megamorphic
  across selectors anyway. Under a strict CSP host (no `unsafe-eval`,
  where `new Function` throws) that shared closure is the fallback:
  correct, with generic-IC speed.

### Extern class declarations

The layer above selectors: declare the shape of a host object in Zena,
and the compiler derives the names. No selector appears in user code —
the member name in the declaration is the property name, and a member
_use_ is what makes its string constant exist.

```zena
// sketch
declare extern class JsResponse {
  status: i32;
  ok: boolean;
  text(): Future<JsString>;
}

let show = async (response: JsResponse): Future<void> => {
  if (response.ok) {
    console.log(await response.text());
  }
};
```

An extern class is a zero-cost nominal wrapper over `externref` — a
type the checker enforces and codegen erases, the shape
`dart:js_interop` extension types and Kotlin/JS `external` declarations
take. Member access lowers onto the generic layer: `response.status`
becomes `js_get_i32(ref, global.get $"status")`, `response.text()`
becomes the promise-returning call over the completion protocol, with
the imported string constants synthesized from the member names.
Reachability prunes them — a member never used imports no constant.
The declared types pick the marshaling per member: `i32`/`f64` cross
directly, `Future<…>` returns ride the async completion path, extern
class types cross as more externrefs, and the signature's arity picks
the fixed-arity import statically.

This is a bindgen in the sense that the boundary code is generated
from declarations, with one difference from systems like
[wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen): nothing
is generated on the JS side. The glue is the fixed generic layer, and
what varies per API is emitted into the wasm module — string-constant
imports and calls against the generic imports — so binding a new host
API adds no runtime JS, which is the size concern this design set out
to remove.

A declaration is a claim the compiler cannot check against the host —
the same trust boundary `@external` functions already have, and a wrong
claim surfaces as a boundary error at runtime (the completion machinery
already rejects mismatched payloads loudly). What the module _can_
prove is which names it touches: with all names arriving as imported
string constants, the module's import section is a complete, statically
readable manifest of every host property it can reach. A host policy
can audit or refuse it at instantiation without running anything —
provided the dynamic `selector()` entry point is not also linked, so a
policy that wants the manifest property can insist on the
declarations-only form by denying the dynamic import.

### Target confinement

This layer is JS-host-only by construction: `anyref`/`externref` have
no Component Model representation, so a component cannot declare them
in a world or have an adapter stub them (see the `zena:error-stack`
module header and [component-emission.md](component-emission.md), Part
2). The component target keeps typed `wasi:http`-style bindings. This
is another reason typed stdlib modules stay the public surface — a
module like `zena:fetch` can back its API with this layer on the JS
targets and with WIT bindings on the component target, while programs
written directly against `zena:js` forgo the component target
entirely.

## Console Implementation

The console standard library (`stdlib/console.zena`) uses the V8-optimized pattern:

```zena
// External host functions receive string ref + length
@external("console", "log_string")
declare function __console_log_string(s: String, len: i32): void;

// Console interface - matches JavaScript's Console API (subset)
export interface Console {
  log(message: String): void;
  error(message: String): void;
  warn(message: String): void;
  info(message: String): void;
  debug(message: String): void;
}

// HostConsole passes strings to host with length
export class HostConsole implements Console {
  log(message: String): void {
    __console_log_string(message, message.length);
  }
  // ... other methods
}

// Global console instance
export let console = new HostConsole();
```

The host function receives the string as `externref` and uses the exported `$stringGetByte` to read its content.

The `@zena-lang/runtime` package provides `createConsoleImports()` which returns the necessary host functions with deferred binding to the `$stringGetByte` export.

## Runtime Package

The `@zena-lang/runtime` npm package provides:

- `createConsoleImports(getExports)`: Console host functions using V8-optimized pattern
- `instantiate(wasm, imports)`: Helper to instantiate Zena modules with merged imports and deferred export binding
- `readByteArray(bytes, length)`: Decode an iterable of bytes to a JS string (for testing)

### Usage

```javascript
import {instantiate} from '@zena-lang/runtime';

// instantiate() automatically sets up console imports with deferred export binding
const result = await instantiate(wasmBytes);

result.instance.exports.main();
```

For custom imports:

```javascript
import {instantiate, createConsoleImports} from '@zena-lang/runtime';

// Deferred exports reference
let instanceExports;

const result = await instantiate(wasmBytes, {
  console: {
    ...createConsoleImports(() => instanceExports),
    // custom overrides
  },
});

instanceExports = result.instance.exports;
result.instance.exports.main();
```

## WASI Consideration

**Decision**: We do **NOT** use WASI Preview 1 for basic I/O.

WASI Preview 1 is designed for Linear Memory with pointers and lengths. Using it with WASM GC would require:

1. Allocating Linear Memory
2. Copying GC data to Linear Memory
3. Managing iovec structs

This adds complexity for a GC-native language. We will revisit when WASI Preview 2 (Component Model) matures.

## Next Steps (Completed)

- [x] Implement `declare` function syntax in Parser
- [x] Implement `@external` decorator
- [x] Implement `import` generation in Emitter
- [x] Build the runtime JS helper package
- [x] Implement Console stdlib with byte streaming
- [x] Optimize to V8-recommended pattern (export getter, JS iteration)

## Future Work

- [x] Anyref host object handles + the `extern` completion kind (see
      "Host object handles" above; replaced `zena:fetch`'s id registry)
- [ ] Generic JS interop layer over interned selectors (see "Generic JS
      interop" above)
- [ ] Per-receiver access control for the interop allowlist
- [ ] Bulk string passing over the `wasm:js-string` builtin functions
      (`fromCharCodeArray`/`intoCharCodeArray`) in place of the
      per-byte getter loop — needs a UTF-8 ↔ UTF-16 decision first:
      the builtins speak `(array i16)` char codes, Zena strings are
      UTF-8 `(array i8)`
- [ ] Linear memory buffer for large data transfer
- [x] Support for passing strings from JS to Zena (`createStringWriter`
      over `$stringCreate`/`$stringSetByte`)
- [ ] External class declarations for JS objects (designed above,
      "Extern class declarations")
- [ ] Watch for WASM type imports and Component Model progress
