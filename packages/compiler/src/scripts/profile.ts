import {execSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');

const defaultTarget = join(
  pkgDir,
  'test-files',
  'benchmarks',
  'stdlib_moderate.zena',
);
let target = defaultTarget;

const args = process.argv.slice(2);
if (args.length > 0) {
  target = args[0];
}

const outDir = join(pkgDir, 'zena', 'out');
if (!existsSync(outDir)) {
  mkdirSync(outDir, {recursive: true});
}

const profileOut = join(outDir, 'profile.json.gz');
const compiledWasm = join(outDir, 'profile-out.wasm');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');

console.log('==================================================');
console.log('Zena Compiler Profiling Runner');
console.log(`Target file: ${target}`);
console.log(`Profile output: ${profileOut}`);
console.log('==================================================\n');

if (!existsSync(zenaCli)) {
  console.error(
    `Error: zena-cli executable not found at ${zenaCli}. Run "npm run build -w @zena-lang/zena-cli" first.`,
  );
  process.exit(1);
}

const cmd = `samply record -s -o "${profileOut}" "${zenaCli}" build "${target}" -o "${compiledWasm}" --time --no-cache`;
console.log(`Running: ${cmd}\n`);

try {
  execSync(cmd, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ZENA_PROFILE: '1',
    },
  });

  console.log('\n==================================================');
  console.log('Profiling Complete!');
  console.log(`Profile file saved to: ${profileOut}`);
  console.log('To view the profile:');
  console.log(`  1. Open https://profiler.firefox.com/ in your browser.`);
  console.log(`  2. Drag and drop the "profile.json.gz" file onto the page.`);
  console.log('==================================================');
} catch (e) {
  console.error('Failed to run profiling session:', e);
  process.exit(1);
}
