/**
 * Compile inline Zena source to WASM bytes fully in memory, using the
 * self-hosted compiler as a library: lsp.wasm (built from
 * packages/language-service/zena/lsp.zena, --target host) exports
 * init()/compileToWasm() and byte accessors. The entry source goes in as a
 * string and the bytes come back through exports — no files, no child
 * process. Only stdlib reads (and any relative imports) go through the
 * `compiler.read_file` callback.
 *
 * This used to load api.wasm, a second --target host build of the compiler
 * that existed for this helper and for the wit-parser's Node tests. Those are
 * Zena tests now, and lsp.wasm already compiles for the host target, so the
 * extra build was retired.
 *
 * `@zena-lang/language-service` wraps the same module with a typed API, which
 * this cannot import: that package depends on this one, so the dependency
 * would be a cycle.
 */
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createConsoleImports,
  createStringWriter,
  createStringReader,
} from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled test files live in packages/runtime/test/.
const pkgRoot = join(__dirname, '..');
const repoRoot = join(pkgRoot, '..', '..');
const lspWasmPath =
  process.env['ZENA_LSP_WASM'] ??
  join(repoRoot, 'packages', 'language-service', 'lsp.wasm');
const stdlibRoot = join(repoRoot, 'packages', 'stdlib', 'zena');

/** The subset of lsp.wasm's exports this helper uses. */
interface LspExports extends WebAssembly.Exports {
  init: (stdlibRoot: unknown) => void;
  compileToWasm: (path: unknown, source: unknown) => unknown;
  getByteArrayLength: (bytes: unknown) => number;
  getByteArrayByte: (bytes: unknown, index: number) => number;
  check: (path: unknown, source: unknown) => unknown;
  getDiagnosticCount: (diagnostics: unknown) => number;
  getDiagnosticLine: (diagnostics: unknown, index: number) => number;
  getDiagnosticColumn: (diagnostics: unknown, index: number) => number;
  getDiagnosticSeverity: (diagnostics: unknown, index: number) => number;
  getDiagnosticMessage: (diagnostics: unknown, index: number) => unknown;
  getDiagnosticFile: (diagnostics: unknown, index: number) => unknown;
  $stringGetLength: (str: unknown) => number;
}

interface Service {
  exports: LspExports;
  writeString: (s: string) => unknown;
  readString: (ref: unknown, len: number) => string;
}

let service: Service | undefined;

/**
 * One instance per process, initialized once. The module is a few megabytes
 * and the service keeps the standard library it has checked, so a second
 * compile in the same file costs only its own source.
 */
const languageService = (): Service => {
  if (service !== undefined) {
    return service;
  }
  let exports: LspExports | undefined;
  let writeString: ((s: string) => unknown) | undefined;
  let readString: ((ref: unknown, len: number) => string) | undefined;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(readFileSync(lspWasmPath)),
    {
      // The compiler times its own phases through `zena:time`, which on
      // the host target is this clock. It never sleeps.
      time: {
        now_ms: () => performance.now(),
        sleep_ms: () => {},
      },
      env: {
        getStackTrace: () => null,
        captureStackTrace: () => null,
        formatStackTrace: () => null,
      },
      console: createConsoleImports(() => exports),
      compiler: {
        read_file: (pathRef: unknown, pathLen: number): unknown => {
          const path = readString!(pathRef, pathLen);
          try {
            return writeString!(readFileSync(path, 'utf8'));
          } catch {
            // Null, not an empty string: the service reports a file it
            // cannot read, where an empty one would compile as a module
            // exporting nothing.
            return null;
          }
        },
      },
    },
  );
  exports = instance.exports as LspExports;
  writeString = createStringWriter(exports);
  readString = createStringReader(exports);
  exports.init(writeString(stdlibRoot));
  service = {exports, writeString, readString};
  return service;
};

/** The errors a failed compile reports, one per line. */
const errorsOf = (
  {exports, writeString, readString}: Service,
  path: string,
  source: string,
): string => {
  const diagnostics = exports.check(writeString(path), writeString(source));
  const lines: string[] = [];
  for (let i = 0; i < exports.getDiagnosticCount(diagnostics); i++) {
    // 0 is the error severity; a warning is not why a compile failed.
    if (exports.getDiagnosticSeverity(diagnostics, i) !== 0) {
      continue;
    }
    const read = (ref: unknown) =>
      readString(ref, exports.$stringGetLength(ref));
    const file = read(exports.getDiagnosticFile(diagnostics, i));
    const line = exports.getDiagnosticLine(diagnostics, i);
    const column = exports.getDiagnosticColumn(diagnostics, i);
    const message = read(exports.getDiagnosticMessage(diagnostics, i));
    // A parse error arrives as a thrown message the service wraps with no
    // position, and that message already names one. Only a diagnostic that
    // has a position gets one prefixed.
    lines.push(
      file === '' && line === 0
        ? message
        : `${file}:${line}:${column} - Error: ${message}`,
    );
  }
  return lines.join('\n');
};

let counter = 0;

export const compile = (source: string): Uint8Array => {
  const zena = languageService();
  const {exports, writeString} = zena;
  // A path of its own per call: the service keys documents by path, and two
  // sources compiled in one process have nothing to do with each other.
  const path = `/inline/test-${counter++}.zena`;
  const bytes = exports.compileToWasm(writeString(path), writeString(source));
  if (!bytes) {
    // compileToWasm says only that it failed; the reason comes from checking
    // the same document, which also folds in parse errors.
    const errors = errorsOf(zena, path, source);
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
