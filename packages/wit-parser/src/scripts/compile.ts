/**
 * Compile a Zena module to WASM bytes with the self-hosted compiler as
 * a library: api.wasm (packages/zena-compiler/zena/out/api.wasm, built
 * by that package's build:api target) exports compileSource() and byte
 * accessors; everything the compilation reads — the entry's relative
 * imports and the stdlib — comes through a read_file host callback.
 * The same shape @zena-lang/runtime's tests use.
 */
import {WASI} from 'node:wasi';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createConsoleImports,
  createStringWriter,
  createStringReader,
} from '@zena-lang/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled location is packages/wit-parser/scripts/; source is src/scripts/.
const isCompiled = !__dirname.includes('/src/');
const pkgRoot = isCompiled
  ? join(__dirname, '..')
  : join(__dirname, '..', '..');
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

/**
 * Compile the Zena module at `absPath` (host target) and return the
 * wasm bytes. Throws with the compiler's diagnostics on error.
 */
export const compileZenaFile = (absPath: string): Uint8Array => {
  const source = readFileSync(absPath, 'utf8');
  // Fresh instance per compile: the compiler's entry is single-shot.
  const {exports, writeString, readString} = instantiateCompiler();
  const rc = exports.compileSource(
    writeString(source),
    writeString(absPath),
    writeString(stdlibRoot),
    writeString('host'),
  );
  if (rc !== 0) {
    const errRef = exports.getErrors();
    const errors = readString(errRef, exports.$stringGetLength(errRef));
    throw new Error(`Compilation failed (${rc} error(s)):\n${errors}`);
  }
  const len = exports.getOutputLength();
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = exports.getOutputByte(i);
  }
  return out;
};
