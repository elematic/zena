/**
 * The playground's compiler worker.
 *
 * Owns one `lsp.wasm` instance, answers checks and editor queries against it,
 * and instantiates the programs it compiles so their output can be streamed
 * back to the console pane. Everything here is a thin adapter over
 * `@zena-lang/language-service`; the Wasm poking lives there.
 */

import {createStringReader, createConsoleImports} from '@zena-lang/runtime';
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

function check(request: CheckRequest): void {
  withService(request.id, (service) => {
    const diagnostics = service.check(request.path, request.source);
    post({type: 'diagnostics', id: request.id, diagnostics});

    if (request.run && !diagnostics.some((d) => d.severity === 'error')) {
      void runProgram(service, request.path, request.source);
    }
  });
}

function hover(request: HoverRequest): void {
  withService(request.id, (service) => {
    post({
      type: 'hover',
      id: request.id,
      hover: service.hover(request.path, request.offset),
    });
  });
}

function completions(request: CompletionsRequest): void {
  withService(request.id, (service) => {
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
  const consoleImports = createConsoleImports(() => programExports);
  const logToPane =
    (level: ConsoleLevel) => (strRef: unknown, length: number) => {
      if (programExports) {
        sendLog(level, createStringReader(programExports)(strRef, length));
      }
    };

  try {
    const {instance} = await WebAssembly.instantiate(bytes, {
      console: {
        ...consoleImports,
        log_string: logToPane('log'),
        error_string: logToPane('error'),
        warn_string: logToPane('warn'),
        info_string: logToPane('info'),
      },
      wasi_snapshot_preview1: {
        fd_write: () => 0,
        proc_exit: () => 0,
        environ_get: () => 0,
        environ_sizes_get: () => 0,
        clock_time_get: () => 0,
      },
      env: {
        getStackTrace: () => null,
        captureStackTrace: () => null,
        formatStackTrace: () => null,
      },
    });
    programExports = instance.exports;

    const main = instance.exports.main;
    if (typeof main !== 'function') {
      sendLog(
        'info',
        `Compiled, but there is nothing to run — export a \`main\` (exports: ${
          Object.keys(instance.exports).join(', ') || 'none'
        }).`,
      );
      return;
    }

    const result = main();
    if (result !== undefined && result !== null && typeof result !== 'object') {
      sendLog('info', `main() returned ${result}`);
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
