import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');

const benchmarksDir = join(pkgDir, 'test-files', 'benchmarks');
const outDir = join(pkgDir, 'zena', 'out', 'benchmarks');

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

let iterations = 5;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs' || args[i] === '-r') {
    const val = parseInt(args[i + 1], 10);
    if (!isNaN(val) && val > 0) {
      iterations = val;
    }
    i++;
  }
}
const ITERATIONS = iterations;


const targets = [
  {
    name: 'minimal.zena',
    path: join(benchmarksDir, 'minimal.zena'),
  },
  {
    name: 'stdlib_moderate.zena',
    path: join(benchmarksDir, 'stdlib_moderate.zena'),
  },
];

const bootstrapCli = join(repoRoot, 'packages', 'cli', 'lib', 'cli.js');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');

console.log('==================================================');
console.log('Starting Zena Compiler Benchmark Suite');
console.log(`Iterations per target: ${ITERATIONS}`);
console.log('==================================================\n');

for (const target of targets) {
  console.log(`Running benchmarks for ${target.name}...`);

  const bootOutWasm = join(outDir, `${target.name}.boot.wasm`);
  const selfOutWasm = join(outDir, `${target.name}.self.wasm`);

  // --- Benchmark Bootstrap Compiler ---
  const bootTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    execSync(
      `node "${bootstrapCli}" build "${target.path}" --target wasi -o "${bootOutWasm}"`,
      { cwd: repoRoot, stdio: 'pipe' }
    );
    const t1 = performance.now();
    bootTimes.push(t1 - t0);
  }
  const bootMean = bootTimes.reduce((a, b) => a + b, 0) / ITERATIONS;

  // --- Benchmark Self-Hosted Compiler & Capture Timings ---
  const selfTimes: number[] = [];
  let totalFileLoad = 0;
  let totalPureParse = 0;
  let totalScope = 0;
  let totalCheck = 0;
  let totalCodegen = 0;
  let totalTime = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const output = execSync(
      `"${zenaCli}" build "${target.path}" -o "${selfOutWasm}" --time --no-cache`,
      { cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe' }
    );
    const t1 = performance.now();
    selfTimes.push(t1 - t0);

    // Parse timing lines like "File Load:  XX.XX ms"
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.startsWith('File Load:')) {
        totalFileLoad += parseFloat(line.split(':')[1].trim());
      } else if (line.startsWith('Pure Parse:')) {
        totalPureParse += parseFloat(line.split(':')[1].trim());
      } else if (line.startsWith('Scope:')) {
        totalScope += parseFloat(line.split(':')[1].trim());
      } else if (line.startsWith('Check:')) {
        totalCheck += parseFloat(line.split(':')[1].trim());
      } else if (line.startsWith('Codegen:')) {
        totalCodegen += parseFloat(line.split(':')[1].trim());
      } else if (line.startsWith('Total:')) {
        totalTime += parseFloat(line.split(':')[1].trim());
      }
    }
  }
  const selfMean = selfTimes.reduce((a, b) => a + b, 0) / ITERATIONS;
  const fileLoad = totalFileLoad / ITERATIONS;
  const pureParse = totalPureParse / ITERATIONS;
  const scope = totalScope / ITERATIONS;
  const check = totalCheck / ITERATIONS;
  const codegen = totalCodegen / ITERATIONS;
  const meanTotalTime = totalTime / ITERATIONS;

  // --- Print Results ---
  console.log(`\nBenchmark Results for ${target.name}:`);
  
  const colWidths = [23, 20, 22, 18];
  const formatRow = (cells: string[]) => {
    return '│ ' + cells.map((cell, i) => {
      if (i === 0) {
        return cell.padEnd(colWidths[i]);
      } else {
        return cell.padStart(colWidths[i]);
      }
    }).join(' │ ') + ' │';
  };
  const makeSeparator = (left: string, mid: string, right: string) => {
    return left + colWidths.map(w => '─'.repeat(w + 2)).join(mid) + right;
  };

  console.log(makeSeparator('┌', '┬', '┐'));
  console.log(formatRow(['Metric', 'Bootstrap Compiler', 'Self-Hosted Compiler', 'Ratio (Self/Boot)']));
  console.log(makeSeparator('├', '┼', '┤'));
  console.log(
    formatRow([
      'Mean Compilation Time',
      `${bootMean.toFixed(2)} ms`,
      `${selfMean.toFixed(2)} ms`,
      `${(selfMean / bootMean).toFixed(2)}x`,
    ])
  );
  console.log(makeSeparator('└', '┴', '┘'));

  if (meanTotalTime > 0) {
    console.log(`\nSelf-Hosted Internal Timing Breakdown (Mean of ${ITERATIONS} Runs):`);
    console.log(`  File Load:   ${fileLoad.toFixed(2).padStart(8)} ms`);
    console.log(`  Pure Parse:  ${pureParse.toFixed(2).padStart(8)} ms`);
    console.log(`  Scope:       ${scope.toFixed(2).padStart(8)} ms`);
    console.log(`  Check:       ${check.toFixed(2).padStart(8)} ms`);
    console.log(`  Codegen:     ${codegen.toFixed(2).padStart(8)} ms`);
    console.log(`  -----------------------------`);
    console.log(`  Total Phase: ${meanTotalTime.toFixed(2).padStart(8)} ms`);
  }
  console.log('\n--------------------------------------------------\n');
}
