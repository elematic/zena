import {WASI} from 'node:wasi';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');

const cliWasmPath = join(pkgDir, 'zena', 'out', 'cli.wasm');
const stdlibDir = join(repoRoot, 'packages', 'stdlib', 'zena');

const compilerArgs = ['zc', ...process.argv.slice(2)];

const wasi = new WASI({
  version: 'preview1',
  args: compilerArgs,
  env: process.env,
  preopens: {
    '/': '/',
    '/stdlib': stdlibDir,
  },
});

const wasmBuffer = await readFile(cliWasmPath);
const imports = {
  ...wasi.getImportObject(),
  env: {
    getStackTrace: () => null,
    captureStackTrace: () => null,
    formatStackTrace: () => null,
  },
};

const {instance} = await WebAssembly.instantiate(wasmBuffer, imports);
wasi.initialize(instance);

const mainFn = instance.exports.main as (() => number) | undefined;
if (typeof mainFn === 'function') {
  const exitCode = mainFn();
  process.exit(exitCode);
} else {
  console.error('Error: main function not found in exports');
  process.exit(1);
}
