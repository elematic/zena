// Copies `.zena` and `.wit` standard library files from `packages/stdlib/zena`
// into `packages/compiler/stdlib` as individual files for npm packaging.

import {copyFileSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const srcRoot = resolve(pkgRoot, '../stdlib/zena');
const destRoot = resolve(pkgRoot, 'stdlib');

rmSync(destRoot, {recursive: true, force: true});

function copyTree(dir) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      copyTree(full);
    } else if (entry.name.endsWith('.zena') || entry.name.endsWith('.wit')) {
      const outPath = join(destRoot, relative(srcRoot, full));
      mkdirSync(dirname(outPath), {recursive: true});
      copyFileSync(full, outPath);
    }
  }
}

copyTree(srcRoot);
