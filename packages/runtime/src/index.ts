export interface ZenaImports {
  env?: Record<string, Function>;
  console?: Record<string, Function>;
  [key: string]: any;
}

/**
 * ByteArray - a WASM GC array of i8 (signed bytes).
 *
 * When accessed from JS, WASM GC arrays are iterable.
 */
export type ByteArray = Iterable<number>;

/**
 * Read a ByteArray (WASM GC array of i8) and decode it to a JavaScript string.
 *
 * @param bytes - The ByteArray from WASM
 * @param length - The length of the string (number of bytes to read)
 * @returns The decoded JavaScript string
 */
export function readByteArray(bytes: ByteArray, length: number): string {
  // Convert the WASM GC array to a Uint8Array
  // WASM GC arrays are iterable in JS
  const uint8 = new Uint8Array(length);
  let i = 0;
  for (const byte of bytes) {
    if (i >= length) break;
    // Handle signed i8 -> unsigned u8 conversion
    uint8[i++] = byte & 0xff;
  }

  // Decode UTF-8 to JavaScript string
  return new TextDecoder().decode(uint8);
}

/**
 * Zena String struct - passed from WASM as a reference.
 *
 * A Zena string is a WASM GC struct with fields:
 * - __vtable: ref (index 0)
 * - bytes: ByteArray (WASM GC array of i8) containing UTF-8 encoded data (index 1)
 * - length: i32 (index 2)
 *
 * NOTE: WASM GC structs are OPAQUE from JavaScript. You cannot access their
 * fields directly. Use exported helper functions or pass bytes/length separately.
 * This type is kept for documentation purposes only.
 */
export interface ZenaString {
  /** The vtable field (index 0) - internal, not accessible from JS */
  readonly __vtable: unknown;
  /** The bytes field (index 1) - a WASM GC array of i8, NOT accessible from JS */
  readonly bytes: ByteArray;
  /** The length field (index 2), NOT accessible from JS */
  readonly length: number;
}

/**
 * @deprecated WASM GC structs are opaque from JavaScript. Use readByteArray instead.
 */
export function readZenaString(zenaString: ZenaString): string {
  // This function cannot work because WASM GC structs are opaque from JS.
  // Kept for backwards compatibility warning.
  throw new Error(
    'WASM GC structs are opaque from JavaScript. ' +
      'Pass ByteArray and length separately to host functions.',
  );
}

/**
 * @deprecated WASM GC structs are opaque from JavaScript.
 */
export function isZenaString(value: unknown): value is ZenaString {
  // WASM GC structs don't expose their fields to JavaScript
  // This check will always fail for actual WASM GC structs
  return false;
}

/**
 * Create a string reader that uses an exported getter function.
 *
 * This is the V8-recommended pattern for reading WASM GC arrays from JS:
 * - WASM exports a getter function $stringGetByte(externref, i32) -> i32
 * - JS receives the string as externref and iterates calling the getter
 *
 * @param exports - The WASM instance exports containing $stringGetByte
 * @returns A function that reads a string from externref + length
 */
function createStringReader(exports: WebAssembly.Exports) {
  const getByte = exports.$stringGetByte as
    | ((str: unknown, index: number) => number)
    | undefined;

  return (strRef: unknown, length: number): string => {
    if (!getByte) {
      throw new Error(
        '$stringGetByte export not found. ' +
          'Make sure the WASM module exports the string getter function.',
      );
    }

    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      // Handle signed i8 -> unsigned u8 conversion
      bytes[i] = getByte(strRef, i) & 0xff;
    }
    return new TextDecoder().decode(bytes);
  };
}

/**
 * Create default console imports that handle Zena types.
 *
 * String logging uses the V8-recommended pattern:
 * - WASM passes the string ref (as externref) and length
 * - JS iterates calling the exported $stringGetByte function
 *
 * This is more efficient than the streaming approach because:
 * - Only 1 host call instead of N+2 (start + N bytes + end)
 * - JS engine can optimize the loop better than WASM calling into JS repeatedly
 *
 * @param getExports - Function to lazily get exports (for deferred binding)
 * @returns Console import object with log, error, warn, info, debug methods
 */
export function createConsoleImports(
  getExports?: () => WebAssembly.Exports | undefined,
): Record<string, Function> {
  // Lazy reader - will be initialized when first string is logged
  let readString: ((strRef: unknown, length: number) => string) | null = null;

  const getReader = () => {
    if (!readString && getExports) {
      const exports = getExports();
      if (exports) {
        readString = createStringReader(exports);
      }
    }
    return readString;
  };

  const logString =
    (method: 'log' | 'error' | 'warn' | 'info' | 'debug') =>
    (strRef: unknown, len: number) => {
      const reader = getReader();
      if (reader) {
        console[method](reader(strRef, len));
      } else {
        // Fallback if exports not available yet
        console[method](`[String: length=${len}]`);
      }
    };

  return {
    log_i32: (arg: number) => console.log(arg),
    log_f32: (arg: number) => console.log(arg),

    // String methods using exported getter
    log_string: logString('log'),
    error_string: logString('error'),
    warn_string: logString('warn'),
    info_string: logString('info'),
    debug_string: logString('debug'),
  };
}

/**
 * Instantiate a WebAssembly module with Zena default and user-provided imports.
 *
 * @param wasm
 * @param userImports
 * @returns
 */
export async function instantiate(
  wasm: BufferSource | WebAssembly.Module,
  userImports: ZenaImports = {},
): Promise<WebAssembly.WebAssemblyInstantiatedSource | WebAssembly.Instance> {
  // Deferred exports reference - will be set after instantiation
  let instanceExports: WebAssembly.Exports | undefined;

  const defaultImports = {
    env: {
      // Default env imports if any
    },
    console: createConsoleImports(() => instanceExports),
  };

  const imports = {
    ...defaultImports,
    ...userImports,
    env: {...defaultImports.env, ...userImports.env},
    console: {...defaultImports.console, ...userImports.console},
  };

  if (wasm instanceof WebAssembly.Module) {
    const instance = await WebAssembly.instantiate(wasm, imports);
    instanceExports = instance.exports;
    return instance;
  }

  const result = await WebAssembly.instantiate(wasm, imports);
  instanceExports = result.instance.exports;
  return result;
}
