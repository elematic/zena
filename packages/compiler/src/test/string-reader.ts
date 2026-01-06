/**
 * String reading utilities for tests.
 *
 * These are local copies of functions from @zena-lang/runtime to avoid
 * circular dependency issues during build.
 */

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
export function createStringReader(exports: WebAssembly.Exports) {
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
