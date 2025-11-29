import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibDir = path.resolve(__dirname, '../stdlib');

export const arrayModule = fs.readFileSync(
  path.join(stdlibDir, 'array.zena'),
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
