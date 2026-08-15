/**
 * The playground's compiler worker.
 *
 * Owns one `lsp.wasm` instance, answers checks and editor queries against it,
 * and instantiates the programs it compiles so their output can be streamed
 * back to the console pane. Everything here is a thin adapter over
 * `@zena-lang/language-service`; the Wasm poking lives there.
 */

import {createStringReader, instantiate, run} from '@zena-lang/runtime';
import {
  createLanguageService,
  createVirtualFileReader,
  type ZenaLanguageService,
} from '@zena-lang/language-service';
import stdlibFiles from '../stdlib-data.json' with {type: 'json'};
import type {
  ConsoleLevel,
  WorkerRequest,
  WorkerResponse,
  InitRequest,
  CheckRequest,
  HoverRequest,
  CompletionsRequest,
} from '../types.js';

/**
 * The worker global, typed for the protocol this worker speaks.
 *
 * A module-scoped declaration, so the file type checks against the DOM lib
 * without the whole WebWorker lib and its conflicting globals.
 */
declare const self: {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const STDLIB_FILES: Record<string, string> = stdlibFiles;

let service: ZenaLanguageService | undefined;

const post = (message: WorkerResponse) => self.postMessage(message);

const sendLog = (level: ConsoleLevel, message: string) =>
  post({type: 'console', level, message});

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

async function init(request: InitRequest): Promise<void> {
  if (!request.wasmBytes && !request.wasmUrl) {
    post({type: 'error', message: 'init needs either wasmBytes or wasmUrl.'});
    return;
  }

  try {
    service = await createLanguageService({
      wasm: request.wasmBytes ?? request.wasmUrl!,
      readFile: createVirtualFileReader(STDLIB_FILES),
      console: {
        log: (message) => sendLog('log', message),
        warn: (message) => sendLog('warn', message),
        error: (message) => sendLog('error', message),
        info: (message) => sendLog('info', message),
      },
    });
    post({type: 'ready'});
  } catch (err) {
    post({
      type: 'error',
      message: `Failed to load the Zena compiler: ${errorMessage(err)}`,
    });
  }
}

/** Runs a request against the service, reporting a missing one as an error. */
function withService(
  id: number,
  run: (service: ZenaLanguageService) => void,
): void {
  if (!service) {
    post({type: 'error', id, message: 'The compiler is not initialized yet.'});
    return;
  }
  try {
    run(service);
  } catch (err) {
    post({type: 'error', id, message: errorMessage(err)});
  }
}

const openDocPaths = new Set<string>();

function syncFiles(
  service: ZenaLanguageService,
  files?: Record<string, string>,
): void {
  if (files) {
    const currentKeys = new Set(Object.keys(files));
    for (const oldPath of openDocPaths) {
      if (!currentKeys.has(oldPath)) {
        service.closeDocument(oldPath);
        openDocPaths.delete(oldPath);
      }
    }
    for (const [path, source] of Object.entries(files)) {
      service.openDocument(path, source);
      openDocPaths.add(path);
    }
  }
}

function check(request: CheckRequest): void {
  withService(request.id, (service) => {
    syncFiles(service, request.files);
    const all = service.check(request.path, request.source);

    // A check reports on every module it reached, not just this document,
    // and a diagnostic from an imported module carries *that* module's
    // line numbers. Placing one in the editor would pin it to whatever
    // line of this document happened to be closest — so only the ones
    // that belong here become markers, and an error somewhere else goes
    // to the console pane, where it can say which file it came from.
    post({type: 'diagnostics', id: request.id, diagnostics: all});

    // Gated on *all* errors: an error in an imported module fails the
    // compile too, however far from this document it is.
    if (request.run && !all.some((d) => d.severity === 'error')) {
      void runProgram(service, request.path, request.source);
    }
  });
}

function hover(request: HoverRequest): void {
  withService(request.id, (service) => {
    syncFiles(service, request.files);
    post({
      type: 'hover',
      id: request.id,
      hover: service.hover(request.path, request.offset),
    });
  });
}

function completions(request: CompletionsRequest): void {
  withService(request.id, (service) => {
    syncFiles(service, request.files);
    post({
      type: 'completions',
      id: request.id,
      completions: service.completions(
        request.path,
        request.offset,
        request.source,
      ),
    });
  });
}

/**
 * Compiles a document and runs its `main()`, with `console.*` wired to the
 * playground's console pane.
 *
 * The program is a second, independent Wasm instance, and it needs its own
 * string reader: the strings it logs live in its heap, not the compiler's.
 *
 * The runtime's `instantiate` supplies the imports a host-target module
 * expects — `env`, `console`, `time`, and the host-async completion
 * plumbing behind them — and only `console`'s string methods are
 * overridden here, to reach the pane instead of the worker's own console.
 * `run` then drives the program to completion: an async `main` returns
 * before its timers have fired, so its value (and its later output)
 * arrives only once nothing is outstanding.
 */
async function runProgram(
  service: ZenaLanguageService,
  path: string,
  source: string,
): Promise<void> {
  const bytes = service.compileToWasm(path, source);
  if (!bytes) {
    sendLog('error', 'The program failed to compile.');
    return;
  }

  let programExports: WebAssembly.Exports | undefined;
  let readString: ((strRef: unknown, length: number) => string) | undefined;
  const logToPane =
    (level: ConsoleLevel) => (strRef: unknown, length: number) => {
      if (!programExports) {
        return;
      }
      readString ??= createStringReader(programExports);
      sendLog(level, readString(strRef, length));
    };

  try {
    const result = await instantiate(bytes, {
      console: {
        log_string: logToPane('log'),
        error_string: logToPane('error'),
        warn_string: logToPane('warn'),
        info_string: logToPane('info'),
        debug_string: logToPane('log'),
      },
      // A host-target module still declares whatever WASI its stdlib
      // reached; there is no filesystem or clock behind it in a worker.
      wasi_snapshot_preview1: {
        fd_write: () => 0,
        proc_exit: () => 0,
        environ_get: () => 0,
        environ_sizes_get: () => 0,
        clock_time_get: () => 0,
      },
    });
    const instance = 'instance' in result ? result.instance : result;
    programExports = instance.exports;

    if (typeof instance.exports.main !== 'function') {
      sendLog(
        'info',
        `Compiled, but there is nothing to run — export a \`main\` (exports: ${
          Object.keys(instance.exports).join(', ') || 'none'
        }).`,
      );
      return;
    }

    const value = await run(instance);
    if (value !== undefined && value !== null && typeof value !== 'object') {
      sendLog('info', `main() returned ${value}`);
    }
  } catch (err) {
    sendLog('error', `Program error: ${errorMessage(err)}`);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'init':
      void init(request);
      break;
    case 'check':
      check(request);
      break;
    case 'hover':
      hover(request);
      break;
    case 'completions':
      completions(request);
      break;
  }
};
