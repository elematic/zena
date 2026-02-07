// Zena compiler written in Zena
// This package contains the self-hosted Zena compiler implementation.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zenaDir = path.resolve(__dirname, './zena');

// Export Zena source files for the compiler
// These will be populated as we build out the compiler

export const getZenaSource = (filename: string): string => {
  return fs.readFileSync(path.join(zenaDir, filename), 'utf-8');
};

export const listZenaFiles = (): string[] => {
  if (!fs.existsSync(zenaDir)) {
    return [];
  }
  return fs.readdirSync(zenaDir).filter((f) => f.endsWith('.zena'));
};
