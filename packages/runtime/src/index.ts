export interface ZenaImports {
  env?: Record<string, Function>;
  console?: Record<string, Function>;
  time?: Record<string, Function>;
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
 * Create a string writer that uses exported create/set functions.
 *
 * This is the inverse of createStringReader — it creates a Zena String
 * from a JavaScript string by:
 * 1. Encoding the JS string to UTF-8 bytes
 * 2. Calling $stringCreate(len) to allocate an empty String of that length
 * 3. Calling $stringSetByte(str, i, byte) for each byte
 *
 * @param exports - The WASM instance exports containing $stringCreate and $stringSetByte
 * @returns A function that converts a JS string to a Zena String externref
 */
export function createStringWriter(exports: WebAssembly.Exports) {
  const create = exports.$stringCreate as
    | ((len: number) => unknown)
    | undefined;
  const setByte = exports.$stringSetByte as
    | ((str: unknown, index: number, value: number) => void)
    | undefined;

  const encoder = new TextEncoder();

  return (jsString: string): unknown => {
    if (!create || !setByte) {
      throw new Error(
        '$stringCreate or $stringSetByte export not found. ' +
          'Make sure the WASM module exports the string creation functions.',
      );
    }

    const bytes = encoder.encode(jsString);
    const strRef = create(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      setByte(strRef, i, bytes[i]);
    }
    return strRef;
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
 * Create the `time` imports backing `zena:time` on a non-WASI host.
 *
 * Two primitives, both synchronous: a monotonic reading and a blocking
 * wait. Time crosses as f64 milliseconds so no BigInt marshalling is
 * involved.
 *
 * `sleep_ms` blocks the thread on purpose. Zena's drain loop parks
 * rather than yielding to an event loop, because the callback-driven
 * alternative needs the host to call back into wasm and only the entry
 * module's exports become wasm exports — a stdlib module cannot publish
 * that entry point yet. Blocking is also what the WASI target does, so a
 * program behaves identically under wasmtime and under Node.
 *
 * `Atomics.wait` is the only way to block a JS thread precisely. It is
 * available on Node's main thread and in workers, but throws on a
 * browser main thread — where blocking would freeze the tab anyway. We
 * surface that as a clear error rather than busy-waiting, which would
 * freeze it just as hard while looking like it worked.
 */
export function createTimeImports(): Record<string, Function> {
  // A private, never-notified location: Atomics.wait on a value that
  // never changes always runs the full timeout and returns 'timed-out'.
  let waitBuffer: Int32Array | null = null;
  const getWaitBuffer = (): Int32Array => {
    if (waitBuffer === null) {
      if (typeof SharedArrayBuffer === 'undefined') {
        throw new Error(
          'zena:time: sleep() needs SharedArrayBuffer to block this thread. ' +
            'In a browser that means a cross-origin-isolated context, and ' +
            'preferably a worker — blocking the main thread freezes the page.',
        );
      }
      waitBuffer = new Int32Array(new SharedArrayBuffer(4));
    }
    return waitBuffer;
  };

  return {
    now_ms: (): number => {
      // performance.now() is monotonic where available; Date.now() is
      // not, but is the only fallback and is adequate for timers.
      return typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
    },
    sleep_ms: (ms: number): void => {
      if (!(ms > 0)) {
        return;
      }
      const result = Atomics.wait(getWaitBuffer(), 0, 0, ms);
      if (result === 'not-equal') {
        // Cannot happen: index 0 is never written. Fail loudly rather
        // than silently returning early from a sleep.
        throw new Error('zena:time: sleep() woke unexpectedly');
      }
    },
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

  let writeString: ((s: string) => unknown) | null = null;
  const envImports = {
    getStackTrace: () => {
      if (!writeString && instanceExports) {
        try {
          writeString = createStringWriter(instanceExports);
        } catch (e) {
          // If we can't write strings (e.g. exports missing), return null
          return null;
        }
      }
      if (!writeString) {
        return null;
      }

      const stack = new Error().stack || 'Stack trace unavailable';
      return writeString(stack);
    },
    captureStackTrace: () => {
      return new Error();
    },
    formatStackTrace: (err: unknown) => {
      if (err == null) {
        return null;
      }
      if (!(err instanceof Error)) {
        throw new Error(
          `formatStackTrace: expected Error instance, got ${typeof err}`,
        );
      }
      if (!writeString && instanceExports) {
        writeString = createStringWriter(instanceExports);
      }
      if (!writeString) {
        throw new Error(
          'formatStackTrace: writeString is not available (missing $stringCreate / $stringSetByte)',
        );
      }
      const stack = err.stack || 'Stack trace unavailable';
      return writeString(stack);
    },
  };

  const defaultImports = {
    env: envImports,
    console: createConsoleImports(() => instanceExports),
    time: createTimeImports(),
  };

  const imports = {
    ...defaultImports,
    ...userImports,
    env: {...defaultImports.env, ...userImports.env},
    console: {...defaultImports.console, ...userImports.console},
    time: {...defaultImports.time, ...userImports.time},
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
