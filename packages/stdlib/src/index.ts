import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibDir = path.resolve(__dirname, './zena');

export const arrayModule = fs.readFileSync(
  path.join(stdlibDir, 'array.zena'),
  'utf-8',
);
export const sequenceModule = fs.readFileSync(
  path.join(stdlibDir, 'sequence.zena'),
  'utf-8',
);
export const immutableArrayModule = fs.readFileSync(
  path.join(stdlibDir, 'immutable-array.zena'),
  'utf-8',
);
export const fixedArrayModule = fs.readFileSync(
  path.join(stdlibDir, 'fixed-array.zena'),
  'utf-8',
);
export const growableArrayModule = fs.readFileSync(
  path.join(stdlibDir, 'growable-array.zena'),
  'utf-8',
);
export const stringModule = fs.readFileSync(
  path.join(stdlibDir, 'string.zena'),
  'utf-8',
);
export const consoleHostModule = fs.readFileSync(
  path.join(stdlibDir, 'console-host.zena'),
  'utf-8',
);
export const consoleWasiModule = fs.readFileSync(
  path.join(stdlibDir, 'console-wasi.zena'),
  'utf-8',
);
export const consoleInterfaceModule = fs.readFileSync(
  path.join(stdlibDir, 'console-interface.zena'),
  'utf-8',
);
export const mapModule = fs.readFileSync(
  path.join(stdlibDir, 'map.zena'),
  'utf-8',
);
export const boxModule = fs.readFileSync(
  path.join(stdlibDir, 'box.zena'),
  'utf-8',
);
export const errorModule = fs.readFileSync(
  path.join(stdlibDir, 'error.zena'),
  'utf-8',
);
export const optionModule = fs.readFileSync(
  path.join(stdlibDir, 'option.zena'),
  'utf-8',
);
export const mathModule = fs.readFileSync(
  path.join(stdlibDir, 'math.zena'),
  'utf-8',
);
export const templateStringsArrayModule = fs.readFileSync(
  path.join(stdlibDir, 'template-strings-array.zena'),
  'utf-8',
);
export const assertModule = fs.readFileSync(
  path.join(stdlibDir, 'assert.zena'),
  'utf-8',
);
export const regexModule = fs.readFileSync(
  path.join(stdlibDir, 'regex.zena'),
  'utf-8',
);

export const testModule = fs.readFileSync(
  path.join(stdlibDir, 'test.zena'),
  'utf-8',
);
export const rangeModule = fs.readFileSync(
  path.join(stdlibDir, 'range.zena'),
  'utf-8',
);
export const iteratorModule = fs.readFileSync(
  path.join(stdlibDir, 'iterator.zena'),
  'utf-8',
);
export const arrayIteratorModule = fs.readFileSync(
  path.join(stdlibDir, 'array-iterator.zena'),
  'utf-8',
);
export const memoryModule = fs.readFileSync(
  path.join(stdlibDir, 'memory.zena'),
  'utf-8',
);
export const byteArrayModule = fs.readFileSync(
  path.join(stdlibDir, 'byte-array.zena'),
  'utf-8',
);
export const fsModule = fs.readFileSync(
  path.join(stdlibDir, 'fs.zena'),
  'utf-8',
);
export const cliModule = fs.readFileSync(
  path.join(stdlibDir, 'cli.zena'),
  'utf-8',
);

// New manifest-based module loader
export {
  type Target,
  isStdlibModule,
  isInternalModule,
  resolveStdlibModule,
  loadStdlibModule,
  getStdlibModule,
  getPublicModules,
  getInternalModules,
} from './lib/module-loader.js';
