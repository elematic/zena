import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibDir = path.resolve(__dirname, '../stdlib');

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
export const consoleModule = fs.readFileSync(
  path.join(stdlibDir, 'console.zena'),
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
export const mathModule = fs.readFileSync(
  path.join(stdlibDir, 'math.zena'),
  'utf-8',
);
