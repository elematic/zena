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

```typescript
@external("module_name", "function_name")
declare function myFunction(a: i32, b: i32): i32;
```

### Implementation

- The compiler generates a `(import ...)` entry in the WASM binary.
- The type signature must be compatible with WASM types.
- For high-level types (String, Class instances), we need a marshaling strategy (see below).

## Exports

Top-level functions and classes can be exported using the `export` keyword.

```typescript
export function add(a: i32, b: i32): i32 {
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

**Solution - V8-Recommended Pattern**: The V8 team recommends (https://github.com/nicolo-ribaudo/nicolo-nicolo-nicolo/issues/1) passing the string reference as `externref` to the host, then having JavaScript iterate by calling an exported getter function.

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

```typescript
// In console.zena
@external("console", "log_string")
declare function __console_log_string(s: string, len: i32): void;

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
- ❌ Cannot pass strings back from JS to Zena (would need inverse approach)

**Why this is faster** (per V8 team):

- JS-to-WASM calls are cheaper than WASM-to-JS calls
- JS can inline and optimize the loop
- Avoids creating many short-lived closures in WASM

### Legacy: Byte Streaming (Deprecated)

The previous byte-streaming approach is still supported but not recommended:

```typescript
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

## Console Implementation

The console standard library (`stdlib/console.zena`) uses the V8-optimized pattern:

```typescript
// External host functions receive string ref + length
@external("console", "log_string")
declare function __console_log_string(s: string, len: i32): void;

// Console interface - matches JavaScript's Console API (subset)
export interface Console {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

// HostConsole passes strings to host with length
export class HostConsole implements Console {
  log(message: string): void {
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

- [ ] Linear memory buffer for large data transfer
- [ ] Support for passing strings from JS to Zena
- [ ] External class declarations for JS objects
- [ ] Watch for WASM type imports and Component Model progress
