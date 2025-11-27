# Host Interop Design

This document outlines the design for interaction between Zena and the host environment (JavaScript/Node.js/Browser).

## Goals

1.  **Imports**: Allow Zena programs to call functions provided by the host.
2.  **Exports**: Allow the host to call functions defined in Zena.
3.  **Data Marshaling**: Define how complex types (Strings, Objects) are passed between Zena and the host.
4.  **Standard Library**: Provide a mechanism for standard library features (like `Console`) to be implemented via host bindings.

## Imports

Zena will support declaring external functions using the `declare` keyword (or similar). These declarations map to WebAssembly imports.

### Syntax Proposal

```typescript
// Declare an external function
// Maps to (import "env" "log" (func ...)) by default?
// Or maybe we need a way to specify the module name.
declare function log(s: string): void;

// With module specification (maybe using a decorator or string literal?)
@external("zena:env", "log")
declare function log(s: string): void;
```

### Implementation

- The compiler will generate a `(import ...)` entry in the WASM binary.
- The type signature must be compatible with WASM types.
- For high-level types (String, Class instances), we need a marshaling strategy.

## Exports

Top-level functions and classes can be exported using the `export` keyword.

```typescript
export function add(a: i32, b: i32): i32 {
  return a + b;
}
```

- **Functions**: Exported directly as WASM exports.
- **Classes**: Not directly exported as a class, but their constructor or factory methods might be. Instances are passed as `(ref struct)` or `(ref eq)`.

## Data Marshaling

### Strings

Zena strings are currently implemented as a struct wrapping a `ByteArray` (WASM GC `(array i8)`).

```wat
(struct $String
  (field $bytes (ref $ByteArray))
  (field $length i32)
)
```

**Passing Zena String to Host:**
- The host receives a `(ref $String)` (opaque object).
- **Problem**: JS cannot easily read the fields of a WASM GC struct without Type Imports (which are not widely supported yet).
- **Solution**:
    1.  **Helper Export**: Zena exports a helper function `string_get_bytes(s: String) -> ByteArray`.
    2.  **JS Side**: JS calls the helper to get the `ByteArray`.
    3.  **ByteArray Access**: JS can access `WebAssembly.Array` (if enabled) or we might need to copy to linear memory if we want broad compatibility (but Zena is GC-native, so we assume a GC-capable host).
    4.  **TextDecoder**: JS uses `TextDecoder` to decode the bytes.

**Passing Host String to Zena:**
- **Solution**:
    1.  **Helper Export**: Zena exports `string_from_bytes(bytes: ByteArray) -> String`.
    2.  **JS Side**: JS allocates a `WebAssembly.Array` (i8) and fills it with UTF-8 encoded bytes from the JS string.
    3.  **Call**: JS calls `string_from_bytes` to create the Zena String.

### Objects / Classes

- **Zena -> Host**: Passed as `externref` or `anyref`. The host holds a reference. To interact with it, the host must call exported Zena methods, passing the reference back as the `this` argument.
- **Host -> Zena**: Passed as `externref`. Zena can hold it, but cannot directly access properties. We might need `extern` classes or interfaces to define the shape and generate bindings (calls to host functions).

## Console Implementation Plan

We want `console.log("Hello")` to work.

1.  **Zena Standard Library**:
    Define `Console` class in Zena (e.g., in `std/console.zena`).

    ```typescript
    // std/console.zena
    
    // Low-level import
    @external("zena:env", "print_string")
    declare function print_string(bytes: ByteArray): void;

    export class Console {
      log(s: string): void {
        // We might need to access s.bytes directly.
        // If 'bytes' is private/internal, we need a way.
        print_string(s.bytes); 
      }
    }
    
    export const console = new Console();
    ```

2.  **Host Runtime (`zena-runtime.js`)**:
    A small JS library that sets up the environment.

    ```javascript
    class ZenaRuntime {
      async instantiate(wasmBytes) {
        const imports = {
          "zena:env": {
            print_string: (byteArray) => {
              // Assume byteArray is a WebAssembly.Array (i8)
              // Convert to Uint8Array
              const bytes = new Uint8Array(byteArray); 
              // Note: Direct view might not work for GC arrays? 
              // We might need to copy element by element if direct access isn't supported.
              // Or use a linear memory approach for I/O buffers.
              
              const text = new TextDecoder().decode(bytes);
              console.log(text);
            }
          }
        };
        return WebAssembly.instantiate(wasmBytes, imports);
      }
    }
    ```

## WASI Consideration

The WebAssembly System Interface (WASI) is a standard for providing system functionality (I/O, Filesystem, Clock) to WASM modules.

### Can we use it?
Yes, specifically `wasi_snapshot_preview1` is widely supported. It provides `fd_write` which can write to `stdout` (file descriptor 1).

### Wiring in Node.js
Node.js has a built-in `wasi` module.
```javascript
import { WASI } from 'node:wasi';
const wasi = new WASI({ version: 'preview1' });
// ... instantiate with wasi.getImportObject()
wasi.start(instance);
```

### Wiring in Browser
Browsers do not support WASI natively. A shim library (like `@bjorn3/browser_wasi_shim` or a custom implementation) is required to map `fd_write` to `console.log`.

### The Problem: Memory Model Mismatch
WASI (Preview 1) is designed for **Linear Memory**. It expects pointers and lengths pointing to a linear memory buffer.
Zena is a **WASM-GC** language. Our data (Strings, Arrays) lives on the GC heap, not in linear memory.

To use WASI `fd_write`, we would need to:
1.  Allocate a Linear Memory in the module.
2.  Copy the Zena String (GC Array) into Linear Memory.
3.  Construct an `iovec` (struct with pointer/length) in Linear Memory.
4.  Call `fd_write` with pointers to Linear Memory.

**Conclusion**:
Using WASI Preview 1 introduces significant complexity (Linear Memory management, copying overhead) for a GC-native language.
**Decision**: We will **NOT** use WASI Preview 1 for basic console output. We will use a custom host import (`zena:env`) that accepts GC references directly. This is more efficient and aligns with the architecture of a GC language. We will revisit this when **WASI Preview 2 (Component Model)**—which supports high-level types and potentially GC references—becomes mature.

## FFI Strategy

We should avoid complex automatic binding generation (like `wasm-bindgen`) for now and stick to a simple, explicit FFI.

1.  **`declare` keyword**: For importing functions.
2.  **`@external` decorator**: To specify module/name.
3.  **Manual Marshaling**: For now, users (or the stdlib) manually convert high-level types to simple types (i32, f32, ByteArray, externref) at the boundary.

## Next Steps

1.  Implement `declare` function syntax in Parser.
2.  Implement `@external` decorator (or similar metadata syntax).
3.  Implement `import` generation in Emitter.
4.  Implement `ByteArray` access in Zena (if not already public).
5.  Build the `ZenaRuntime` JS helper.
