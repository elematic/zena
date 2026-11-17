// Bundles `packages/compiler/stdlib/**/*.zena` into `src/stdlib-data.json` for
// `<zena-playground>`'s browser worker (`createVirtualFileReader`).

import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, '..');
const stdlibDir = resolve(pkgDir, '../compiler/stdlib');
const outDir = join(pkgDir, 'src');

mkdirSync(outDir, {recursive: true});

const stdlibFiles = {};

function scanDir(dir) {
  const entries = readdirSync(dir, {withFileTypes: true}).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full);
    } else if (entry.name.endsWith('.zena')) {
      const rel = relative(stdlibDir, full).replaceAll('\\', '/');
      stdlibFiles[`/stdlib/${rel}`] = readFileSync(full, 'utf8');
    }
  }
}

scanDir(stdlibDir);

const outFile = join(outDir, 'stdlib-data.json');
const content = JSON.stringify(stdlibFiles, null, 2) + '\n';
try {
  if (readFileSync(outFile, 'utf8') === content) {
    process.exit(0);
  }
} catch {}
writeFileSync(outFile, content, 'utf8');
