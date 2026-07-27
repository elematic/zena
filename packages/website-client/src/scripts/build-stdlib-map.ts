import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..', '..');
const repoRoot = join(pkgDir, '..', '..');
const stdlibDir = join(repoRoot, 'packages', 'stdlib', 'zena');
const outDir = join(pkgDir, 'src', 'lib');

mkdirSync(outDir, { recursive: true });

const files = readdirSync(stdlibDir).filter((f) => f.endsWith('.zena'));

const stdlibFiles: Record<string, string> = {};

for (const file of files) {
  const content = readFileSync(join(stdlibDir, file), 'utf8');
  const moduleName = file.replace(/\.zena$/, '');

  // Provide lookups for both filesystem paths and zena: package specifiers
  stdlibFiles[`/stdlib/${file}`] = content;
  stdlibFiles[`zena:${moduleName}`] = content;
}

const outFile = join(outDir, 'stdlib-data.json');
writeFileSync(outFile, JSON.stringify(stdlibFiles, null, 2), 'utf8');
console.log(`Generated ${outFile} with ${files.length} stdlib files (${Object.keys(stdlibFiles).length} keys).`);
