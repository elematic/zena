/**
 * Compile inline Zena source to WASM bytes fully in memory, using the
 * self-hosted compiler as a library: api.wasm (built from
 * packages/zena-compiler/zena/cli/api.zena, --target host) exports
 * compileSource()/getOutputLength()/getOutputByte(). The entry source
 * goes in as a string and the bytes come back through exports — no
 * files, no child process. Only stdlib reads (and any relative imports)
 * go through the `compiler.read_file` callback.
 */
import {WASI} from 'node:wasi';
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
const apiWasmPath =
  process.env['ZENA_COMPILER_API_WASM'] ??
  join(repoRoot, 'packages', 'zena-compiler', 'zena', 'out', 'api.wasm');
const stdlibRoot = join(repoRoot, 'packages', 'stdlib', 'zena');

interface ApiExports extends WebAssembly.Exports {
  compileSource: (
    source: unknown,
    entryPath: unknown,
    stdlibRoot: unknown,
    target: unknown,
  ) => number;
  getErrors: () => unknown;
  getOutputLength: () => number;
  getOutputByte: (index: number) => number;
  $stringGetLength: (str: unknown) => number;
}

let compilerModule: WebAssembly.Module | undefined;

const instantiateCompiler = () => {
  compilerModule ??= new WebAssembly.Module(readFileSync(apiWasmPath));

  let exports: ApiExports | undefined;
  let writeString: ((s: string) => unknown) | undefined;
  let readString: ((ref: unknown, len: number) => string) | undefined;

  const wasi = new WASI({version: 'preview1', args: [], env: {}});
  const instance = new WebAssembly.Instance(compilerModule, {
    ...wasi.getImportObject(),
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
          return writeString!('');
        }
      },
    },
  });
  exports = instance.exports as ApiExports;
  wasi.initialize(instance as object as Parameters<WASI['initialize']>[0]);
  writeString = createStringWriter(exports);
  readString = createStringReader(exports);
  return {exports, writeString, readString};
};

export const compile = (source: string): Uint8Array => {
  // Fresh instance per call: compilations don't share compiler state.
  // The module itself compiles once per process.
  const {exports, writeString, readString} = instantiateCompiler();
  const rc = exports.compileSource(
    writeString(source),
    writeString('/inline/test.zena'),
    writeString(stdlibRoot),
    writeString('host'),
  );
  if (rc !== 0) {
    const errRef = exports.getErrors();
    const errors = readString(errRef, exports.$stringGetLength(errRef));
    throw new Error(`Zena compilation failed (${rc} error(s)):\n${errors}`);
  }
  const len = exports.getOutputLength();
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = exports.getOutputByte(i);
  }
  return out;
};
