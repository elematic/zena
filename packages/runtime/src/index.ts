export interface ZenaImports {
  env?: Record<string, Function>;
  console?: Record<string, Function>;
  // Values may be `WebAssembly.Suspending` objects, not just functions.
  time?: Record<string, unknown>;
  /** The imports behind `zena:fetch`. Supplied by default from the
   * host's own `fetch()`; replace them to reroute network access
   * (stubbing `globalThis.fetch` is usually easier — the tests do). */
  web?: Record<string, unknown>;
  /**
   * Promise-returning host functions, exposed to Zena as async imports
   * (async.md §4, Level 2). Keyed by import module, then by name.
   *
   * Zena mints a handle and passes it out with the call:
   *
   * ```zena
   * @external("db", "lookup")
   * declare function __lookup(handle: i32, key: String, len: i32): void;
   *
   * export let lookup = (key: String): Future<String> => {
   *   let p = pending<String>();
   *   __lookup(p.handle, key, key.length);
   *   return p.future;
   * };
   * ```
   *
   * The function written here does *not* see the handle — it takes the
   * remaining arguments and returns a promise, and `kind` says which
   * payload the handle was registered for:
   *
   * ```ts
   * let exports: WebAssembly.Exports;
   * const instance = await instantiate(wasm, {
   *   asyncImports: {
   *     db: {
   *       lookup: {
   *         kind: 'string',
   *         fn: (ref: unknown, len: number) =>
   *           database.get(createStringReader(exports)(ref, len)),
   *       },
   *     },
   *   },
   * });
   * exports = instance.exports;
   * ```
   *
   * Wrapping them here rather than by hand is what keeps `run()` honest:
   * these operations share the outstanding-work count with timers, so a
   * program is not "finished" while one is in flight.
   */
  asyncImports?: Record<
    string,
    Record<
      string,
      {
        kind: CompletionKind;
        fn: (...args: any[]) => PromiseLike<unknown> | unknown;
      }
    >
  >;
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

/** Tracks pending timer wakes for one instance, so `run()` can tell
 * when a program has finished. Keyed by the instance's exports. */
const idleWaiters = new WeakMap<object, () => Promise<void>>();

export interface TimeHost {
  imports: Record<string, unknown>;
  /** Resolves once no scheduled wake is outstanding. */
  idle(): Promise<void>;
}

/**
 * The `time` host backing `zena:time` on a non-WASI host.
 *
 * `sleep_ms` is an ordinary host-async operation: it settles the handle
 * Zena minted once the timeout elapses, through exactly the same
 * completion path `fetch` or any other import uses. Nothing blocks and
 * nothing polls, which is the only workable answer on a browser main
 * thread — and it means a timer needs no mechanism of its own.
 *
 * (WASI is the target that does need one, because it *can* block: its
 * drain sorts pending deadlines and sleeps on the nearest through
 * `poll_oneoff`. That machinery lives in `stdlib/zena/time/queue.zena`
 * and is reachable only from the WASI entry.)
 *
 * Time crosses as f64 milliseconds so no BigInt marshalling is involved.
 *
 * This inherits `setTimeout`'s web semantics deliberately, including the
 * >=4ms floor browsers impose once timeouts nest more than five deep.
 */
export function createTimeHost(
  getExports?: () => WebAssembly.Exports | undefined,
  work: PendingWork = createPendingWork(),
  hostAsync: HostAsync = createHostAsync(getExports, work),
): TimeHost {
  return {
    imports: {
      now_ms: (): number => performance.now(),
      sleep_ms: (handle: number, ms: number): void => {
        hostAsync.settle(
          handle,
          new Promise((resolve) => setTimeout(resolve, ms > 0 ? ms : 0)),
          'void',
        );
      },
    },
    idle: work.idle,
  };
}

/**
 * Outstanding host work, shared by every source that can settle a Zena
 * future from the JS event loop.
 *
 * `run()` needs to know when a program is finished, and on a host that
 * cannot block that is not something the module can report: `main`
 * returns with work pending by design. What actually ends a program is
 * the JS side running out of things that could still call back in — so
 * the count lives here, and timers and host I/O share it. Two separate
 * counters would let `run()` resolve while the other kind was still in
 * flight.
 */
interface PendingWork {
  /** Register one outstanding operation. */
  enter(): void;
  /** Retire one, after any re-entry into the module it caused. */
  leave(): void;
  /**
   * Record a failure that happened while re-entering the module.
   *
   * Calling back into wasm from a timer or a promise handler means any
   * throw lands on a stack no caller owns — it would surface as an
   * unhandled rejection and the program would go on to fail later with
   * something less informative (a drain that never settles reports a
   * deadlock). Recording it here hands it to `run()`, which is the one
   * place a caller is waiting. First failure wins; the module is not in
   * a state where later ones say more.
   */
  fail(error: unknown): void;
  /** Resolves once nothing is outstanding, or rejects with the first
   * failure recorded above. */
  idle(): Promise<void>;
}

function createPendingWork(): PendingWork {
  let outstanding = 0;
  let failure: {error: unknown} | null = null;
  const waiters: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];

  const release = () => {
    for (const waiter of waiters.splice(0)) {
      if (failure) {
        waiter.reject(failure.error);
      } else {
        waiter.resolve();
      }
    }
  };

  return {
    enter: () => {
      outstanding += 1;
    },
    leave: () => {
      outstanding -= 1;
      // A drain that armed another timer or started more host work
      // bumped the count again before we got here, so zero really does
      // mean "nothing left anywhere".
      if (outstanding === 0) {
        release();
      }
    },
    fail: (error: unknown) => {
      failure ??= {error};
      release();
    },
    idle: (): Promise<void> => {
      if (failure) {
        return Promise.reject(failure.error);
      }
      if (outstanding === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) =>
        waiters.push({resolve, reject}),
      );
    },
  };
}

/** Ping the module's drain loop, if it has one. Modules that never
 * reach `zena:async` do not export it, and pinging them is a no-op. */
function drainModule(getExports?: () => WebAssembly.Exports | undefined) {
  const drain = getExports?.()?.['__zena_drain'] as (() => void) | undefined;
  drain?.();
}

/** The payload types a host completion can carry — the closed set of
 * things a JS host can hand to wasm, which is why Zena needs one export
 * per kind and no more. */
export type CompletionKind = 'void' | 'i32' | 'f64' | 'string';

export interface HostAsync {
  /**
   * Settle a Zena handle with the outcome of some JS work.
   *
   * The handle came from `pending<T>()` on the Zena side, which handed
   * it out with the request. `kind` says which `__zena_complete_*`
   * export to call, and must match the `T` the handle was registered
   * for — if it does not, Zena throws naming both, rather than coercing.
   *
   * A rejection settles the handle as a failed future carrying the
   * rejection's message, whatever `kind` says: failure needs no payload.
   */
  settle(
    handle: number,
    work: PromiseLike<unknown> | unknown,
    kind: CompletionKind,
  ): void;
  /**
   * Wrap a promise-returning function as a Zena host-async import.
   *
   * The wrapped function takes the handle as its first argument, which
   * is the calling convention a Zena `@external` declaration is written
   * to: `declare function fetchText(handle: i32, url: String): void`.
   */
  wrap<A extends unknown[]>(
    fn: (...args: A) => PromiseLike<unknown> | unknown,
    kind: CompletionKind,
  ): (handle: number, ...args: A) => void;
  /** Resolves once no host operation is outstanding. */
  idle(): Promise<void>;
}

/**
 * The JS half of `zena:host-async` (async.md §4, Level 2).
 *
 * When the work finishes, call the module's `__zena_complete_<kind>`
 * export with the handle and the value, then `__zena_drain()`. That is
 * the whole protocol — the handle the host was given already names the
 * future, so nothing has to be looked up or asked back for.
 *
 * There are no imports here. Zena calls out to start an operation
 * through whatever `@external` the binding declares; the host calls back
 * in through the completion exports. Neither side polls the other.
 */
export function createHostAsync(
  getExports?: () => WebAssembly.Exports | undefined,
  work: PendingWork = createPendingWork(),
): HostAsync {
  let writeString: ((s: string) => unknown) | null = null;
  const toZenaString = (s: string): unknown => {
    if (!writeString) {
      const exports = getExports?.();
      if (!exports) {
        throw new Error(
          'host_async: cannot build a Zena string before instantiation',
        );
      }
      writeString = createStringWriter(exports);
    }
    return writeString(s);
  };

  const completionExport = (name: string): Function => {
    const fn = getExports?.()?.[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `host_async: the module does not export ${name}. ` +
          'A module only exports the completion entry points if it ' +
          "imports 'zena:host-async'.",
      );
    }
    return fn;
  };

  const complete = (handle: number, value: unknown, kind: CompletionKind) => {
    switch (kind) {
      case 'void':
        completionExport('__zena_complete_void')(handle);
        return;
      case 'i32':
        completionExport('__zena_complete_i32')(handle, Number(value) | 0);
        return;
      case 'f64':
        completionExport('__zena_complete_f64')(handle, Number(value));
        return;
      case 'string':
        completionExport('__zena_complete_string')(
          handle,
          toZenaString(String(value)),
        );
        return;
    }
    throw new Error(`host_async: unknown completion kind '${kind}'`);
  };

  const fail = (handle: number, reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    completionExport('__zena_complete_error')(handle, toZenaString(message));
  };

  const settle = (
    handle: number,
    value: PromiseLike<unknown> | unknown,
    kind: CompletionKind,
  ) => {
    work.enter();
    Promise.resolve(value).then(
      (v) => {
        try {
          complete(handle, v, kind);
          drainModule(getExports);
        } catch (e) {
          // The module threw while we were settling it — a mismatched
          // payload, a completion for a spent handle, or an error out of
          // the resumed code. Hand it to run(); nobody owns this stack.
          work.fail(e);
        } finally {
          work.leave();
        }
      },
      (e) => {
        try {
          fail(handle, e);
          drainModule(getExports);
        } catch (inner) {
          work.fail(inner);
        } finally {
          work.leave();
        }
      },
    );
  };

  return {
    settle,
    wrap:
      <A extends unknown[]>(
        fn: (...args: A) => PromiseLike<unknown> | unknown,
        kind: CompletionKind,
      ) =>
      (handle: number, ...args: A): void => {
        try {
          settle(handle, fn(...args), kind);
        } catch (e) {
          // A synchronous throw is the operation failing, not the host
          // failing: report it through the handle like any rejection,
          // rather than unwinding back into wasm.
          settle(handle, Promise.reject(e), kind);
        }
      },
    idle: work.idle,
  };
}

export interface WebHost {
  imports: Record<string, unknown>;
  /** Resolves once no request is outstanding. */
  idle(): Promise<void>;
}

/**
 * The `web` host backing `zena:fetch` on a JS host.
 *
 * `fetch_start` runs the host's own `fetch()` and settles the handle
 * with an id naming the `Response`, which stays here until
 * `response_text` reads its body — so a non-2xx status is a normal
 * completion the Zena side inspects, exactly like the web, and only
 * "no response at all" (network error, CORS refusal, no `fetch()` on
 * this host) fails the future. Keeping the response on this side of
 * the boundary is also what a streamed body will want: the stream
 * stays here, and reads cross one completion at a time.
 *
 * `response_drop` releases an entry without reading it — the Zena
 * side's `Response.dispose()`. A response neither read nor disposed is
 * retired with the instance: the registry lives in this closure, so it
 * cannot outlive the program that filled it.
 */
export function createWebHost(
  getExports?: () => WebAssembly.Exports | undefined,
  work: PendingWork = createPendingWork(),
  hostAsync: HostAsync = createHostAsync(getExports, work),
): WebHost {
  let readString: ((ref: unknown, len: number) => string) | null = null;
  const readZena = (ref: unknown, len: number): string => {
    if (!readString) {
      const exports = getExports?.();
      if (!exports) {
        throw new Error('web: cannot read a Zena string before instantiation');
      }
      readString = createStringReader(exports);
    }
    return readString(ref, len);
  };

  let nextResponseId = 1;
  const responses = new Map<number, Response>();
  const responseOf = (id: number): Response => {
    const response = responses.get(id);
    if (!response) {
      throw new Error(`zena:fetch: no response with id ${id}`);
    }
    return response;
  };

  return {
    imports: {
      fetch_start: hostAsync.wrap(async (ref: unknown, len: number) => {
        const response = await globalThis.fetch(readZena(ref, len));
        const id = nextResponseId++;
        responses.set(id, response);
        return id;
      }, 'i32'),
      response_status: (id: number): number => responseOf(id).status,
      response_text: hostAsync.wrap((id: number) => {
        const response = responseOf(id);
        responses.delete(id);
        return response.text();
      }, 'string'),
      // Zena's Response.dispose() guards against double release, so an
      // unknown id here is not an error worth distinguishing.
      response_drop: (id: number): void => {
        responses.delete(id);
      },
    },
    idle: work.idle,
  };
}

/** The `time` imports alone, for callers assembling their own object. */
export function createTimeImports(
  getExports?: () => WebAssembly.Exports | undefined,
): Record<string, unknown> {
  return createTimeHost(getExports).imports;
}

/** True if the compiler emitted the split entry, i.e. `main` is async. */
export function isAsyncMain(instance: WebAssembly.Instance): boolean {
  return (
    typeof instance.exports['__zena_main_start'] === 'function' &&
    typeof instance.exports['__zena_main_result'] === 'function'
  );
}

/**
 * Run a synchronous `main` and return its value.
 *
 * Throws if `main` is async, rather than returning something that is
 * only sometimes a promise: a caller that wants a value and a caller
 * that wants a promise want different functions, and guessing which one
 * this is from the module would make every call site defensive.
 */
export function runSync(
  instance: WebAssembly.Instance,
  ...args: unknown[]
): unknown {
  if (isAsyncMain(instance)) {
    throw new Error(
      'runSync(): this module\'s `main` is async, so its value is not ' +
        'available synchronously — use run().',
    );
  }
  const main = instance.exports['main'] as (...a: unknown[]) => unknown;
  if (typeof main !== 'function') {
    throw new Error('runSync(): the module has no `main` export');
  }
  return main(...args);
}

/**
 * Run a Zena module's `main` to completion and resolve with its value.
 *
 * Always returns a promise, whether or not `main` is async — a sync
 * `main` simply resolves on the first turn.
 *
 * An async `main` needs this because on a host that cannot block — every
 * browser main thread — it returns before its timers have fired and
 * before any host I/O has come back. The compiler therefore splits it
 * into `__zena_main_start` (run the body, park the future) and
 * `__zena_main_result` (unwrap it), and this drives the pair: start the
 * program, let the event loop deliver every wake and completion, and
 * read the result once nothing is outstanding.
 *
 * `main` itself cannot be the promise-returning export: a wasm export
 * returns a wasm value, and handing back a JS promise would need JSPI,
 * which this design deliberately does not depend on.
 */
export async function run(
  instance: WebAssembly.Instance,
  ...args: unknown[]
): Promise<unknown> {
  const exports = instance.exports;
  if (!isAsyncMain(instance)) {
    return runSync(instance, ...args);
  }
  const start = exports['__zena_main_start'] as (...a: unknown[]) => void;
  const result = exports['__zena_main_result'] as () => unknown;

  start(...args);
  const idle = idleWaiters.get(exports as object);
  if (idle) {
    await idle();
  }
  return result();
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

  // One tracker for both: `run()` must not resolve while either a timer
  // or a host operation could still call back into the module.
  const pending = createPendingWork();
  const hostAsync = createHostAsync(() => instanceExports, pending);
  const timeHost = createTimeHost(() => instanceExports, pending, hostAsync);
  const webHost = createWebHost(() => instanceExports, pending, hostAsync);
  const defaultImports = {
    env: envImports,
    console: createConsoleImports(() => instanceExports),
    time: timeHost.imports,
    web: webHost.imports,
  };

  const {asyncImports, ...plainUserImports} = userImports;
  const imports: Record<string, Record<string, unknown>> = {
    ...defaultImports,
    ...plainUserImports,
    env: {...defaultImports.env, ...userImports.env},
    console: {...defaultImports.console, ...userImports.console},
    time: {...defaultImports.time, ...userImports.time},
    web: {...defaultImports.web, ...userImports.web},
  };

  // Promise-returning imports become handle-taking void imports, sharing
  // the tracker above so `run()` waits for them.
  for (const [module, fns] of Object.entries(asyncImports ?? {})) {
    const wrapped: Record<string, unknown> = {...imports[module]};
    for (const [name, spec] of Object.entries(fns)) {
      wrapped[name] = hostAsync.wrap(spec.fn, spec.kind);
    }
    imports[module] = wrapped;
  }

  // `time.sleep_ms` may be a WebAssembly.Suspending, which TypeScript's
  // ImportValue union does not yet describe.
  const importObject = imports as unknown as WebAssembly.Imports;

  if (wasm instanceof WebAssembly.Module) {
    const instance = await WebAssembly.instantiate(wasm, importObject);
    instanceExports = instance.exports;
    idleWaiters.set(instanceExports, pending.idle);
    return instance;
  }

  const result = await WebAssembly.instantiate(wasm, importObject);
  instanceExports = result.instance.exports;
  idleWaiters.set(instanceExports, pending.idle);
  return result;
}
