import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..', '..');
const repoRoot = join(pkgDir, '..', '..');
const stdlibDir = join(repoRoot, 'packages', 'stdlib', 'zena');
const outDir = join(pkgDir, 'src', 'lib');

mkdirSync(outDir, {recursive: true});

const stdlibFiles: Record<string, string> = {};

function scanDir(dir: string) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath);
    } else if (entry.endsWith('.zena')) {
      const content = readFileSync(fullPath, 'utf8');
      const relPath = relative(stdlibDir, fullPath);
      stdlibFiles[`/stdlib/${relPath}`] = content;
      stdlibFiles[`zena:${relPath}`] = content;

      if (!relPath.includes('/')) {
        const moduleName = relPath.replace(/\.zena$/, '');
        stdlibFiles[`zena:${moduleName}`] = content;
      }
    }
  }
}

scanDir(stdlibDir);

const outFile = join(outDir, 'stdlib-data.json');
writeFileSync(outFile, JSON.stringify(stdlibFiles, null, 2), 'utf8');
console.log(
  `Generated ${outFile} with ${Object.keys(stdlibFiles).length} stdlib keys.`,
);
