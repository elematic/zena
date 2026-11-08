/**
 * Compiles inline Zena source to a js-target module, in memory, through
 * the language service module (lsp.wasm). The same helper the runtime
 * package's tests use; copied because that package does not export its
 * test files. The host imports the service needs come from the runtime,
 * a development dependency of this package.
 */
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createHostAsync,
  createPromiseImports,
  numberImports,
  stringImports,
} from '@zena-lang/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled test files live in packages/wasm-web-ui/test/.
const pkgRoot = join(__dirname, '..');
const repoRoot = join(pkgRoot, '..', '..');
const lspWasmPath =
  process.env['ZENA_LSP_WASM'] ??
  join(repoRoot, 'packages', 'language-service', 'lsp.wasm');
const stdlibRoot = join(repoRoot, 'packages', 'stdlib', 'zena');

interface LspExports extends WebAssembly.Exports {
  init: (stdlibRoot: string) => Promise<void>;
  compileToWasm: (path: string, source: string) => Promise<unknown>;
  getByteArrayLength: (bytes: unknown) => number;
  getByteArrayByte: (bytes: unknown, index: number) => number;
  check: (path: string, source: string) => Promise<unknown>;
  getDiagnosticCount: (diagnostics: unknown) => number;
  getDiagnosticLine: (diagnostics: unknown, index: number) => number;
  getDiagnosticColumn: (diagnostics: unknown, index: number) => number;
  getDiagnosticSeverity: (diagnostics: unknown, index: number) => number;
  getDiagnosticMessage: (diagnostics: unknown, index: number) => unknown;
  getDiagnosticFile: (diagnostics: unknown, index: number) => unknown;
  $stringCreate: (s: string) => unknown;
  $stringGetHandle: (s: unknown) => string;
}

let service: LspExports | undefined;

/**
 * One instance per process. The language service is itself a js-target
 * module, so strings cross it as JavaScript strings: `$stringCreate`
 * wraps one for a parameter, `$stringGetHandle` unwraps a result.
 */
const languageService = async (): Promise<LspExports> => {
  if (service !== undefined) {
    return service;
  }
  // The compiler reads files through a host-async import, and the
  // exports that compile return promises through `zena:js`.
  const hostAsync = createHostAsync(() => service);
  const module = new WebAssembly.Module(readFileSync(lspWasmPath), {
    builtins: ['js-string'],
    importedStringConstants: '_',
  });
  const instance = new WebAssembly.Instance(module, {
    time: {
      now_ms: () => performance.now(),
      sleep_ms: () => {},
      sleep_cancel: () => {},
    },
    env: {
      getStackTrace: () => null,
      captureStackTrace: () => null,
      formatStackTrace: () => null,
    },
    console: {
      log_string: (s: string) => console.log(s),
      error_string: (s: string) => console.error(s),
      warn_string: (s: string) => console.warn(s),
      info_string: (s: string) => console.info(s),
      debug_string: (s: string) => console.debug(s),
      log_i32: (n: number) => console.log(n),
      log_f32: (n: number) => console.log(n),
    },
    compiler: {
      read_file: hostAsync.wrap(async (path: unknown): Promise<string> => {
        const exports = service!;
        return readFileSync(exports.$stringGetHandle(path), 'utf8');
      }, 'string'),
    },
    js: createPromiseImports(() => service) as WebAssembly.ModuleImports,
    'zena:host:string': stringImports,
    'zena:host:number': numberImports,
  });
  service = instance.exports as LspExports;
  await service.init(service.$stringCreate(stdlibRoot) as string);
  return service;
};

const errorsOf = async (exports: LspExports, path: string, source: string) => {
  const diagnostics = await exports.check(
    exports.$stringCreate(path) as string,
    exports.$stringCreate(source) as string,
  );
  const lines: string[] = [];
  for (let i = 0; i < exports.getDiagnosticCount(diagnostics); i++) {
    if (exports.getDiagnosticSeverity(diagnostics, i) !== 0) {
      continue;
    }
    const read = (ref: unknown) => exports.$stringGetHandle(ref);
    const file = read(exports.getDiagnosticFile(diagnostics, i));
    const line = exports.getDiagnosticLine(diagnostics, i);
    const column = exports.getDiagnosticColumn(diagnostics, i);
    const message = read(exports.getDiagnosticMessage(diagnostics, i));
    lines.push(
      file === '' && line === 0
        ? message
        : `${file}:${line}:${column} - Error: ${message}`,
    );
  }
  return lines.join('\n');
};

let counter = 0;

/** Compiles `source` for the js target and returns the module bytes. */
export const compile = async (source: string): Promise<Uint8Array> => {
  const exports = await languageService();
  const path = `/inline/wasm-web-ui-test-${counter++}.zena`;
  const bytes = await exports.compileToWasm(
    exports.$stringCreate(path) as string,
    exports.$stringCreate(source) as string,
  );
  if (!bytes) {
    const errors = await errorsOf(exports, path, source);
    throw new Error(
      `Zena compilation failed:\n${
        errors === ''
          ? 'the compiler reported no errors, so it threw — see its console output'
          : errors
      }`,
    );
  }
  const len = exports.getByteArrayLength(bytes);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = exports.getByteArrayByte(bytes, i) & 0xff;
  }
  return out;
};
