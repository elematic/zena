import {WASI} from 'node:wasi';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const wasmFile = process.argv[2];
const filterArg = process.argv[3] || '';

if (!wasmFile) {
  console.error('Error: No WASM file specified');
  process.exit(1);
}

const wasi = new WASI({
  version: 'preview1',
  args: [wasmFile, filterArg],
  env: process.env,
});

const wasmBuffer = await readFile(resolve(process.cwd(), wasmFile));
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
  mainFn();
} else {
  console.error('Error: main function not found in exports');
  process.exit(1);
}
