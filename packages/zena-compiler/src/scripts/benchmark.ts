import {execSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname, '..');
const repoRoot = join(pkgDir, '..', '..');

const benchmarksDir = join(pkgDir, 'test-files', 'benchmarks');
const outDir = join(pkgDir, 'zena', 'out', 'benchmarks');

if (!existsSync(outDir)) {
  mkdirSync(outDir, {recursive: true});
}

let iterations = 5;
let runCompiler = false;
let runStrings = false;
let runBasic = false;
let filter = '';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--runs' || arg === '-r') {
    const val = parseInt(args[i + 1], 10);
    if (!isNaN(val) && val > 0) {
      iterations = val;
    }
    i++;
  } else if (arg === '--compiler') {
    runCompiler = true;
  } else if (arg === '--strings') {
    runStrings = true;
  } else if (arg === '--basic') {
    runBasic = true;
  } else if (arg === '--filter' || arg === '-f') {
    filter = args[i + 1] || '';
    i++;
  }
}

if (!runCompiler && !runStrings && !runBasic) {
  runCompiler = true;
  runStrings = true;
  runBasic = true;
}

const ITERATIONS = iterations;

let targets = [
  {
    name: 'minimal.zena',
    path: join(benchmarksDir, 'minimal.zena'),
  },
  {
    name: 'stdlib_moderate.zena',
    path: join(benchmarksDir, 'stdlib_moderate.zena'),
  },
  {
    name: 'self_compile.zena',
    path: join(repoRoot, 'packages', 'zena-compiler', 'zena', 'cli', 'main.zena'),
  },
];

if (filter) {
  targets = targets.filter((t) => t.name.includes(filter));
}

const bootstrapCli = join(repoRoot, 'packages', 'cli', 'lib', 'cli.js');
const zenaCli = join(repoRoot, 'target', 'release', 'zena-cli');
const runWasiNode = join(pkgDir, 'scripts', 'run-wasi-node.js');
const runCompilerNode = join(pkgDir, 'scripts', 'run-compiler-node.js');

if (runCompiler && targets.length > 0) {
  console.log('==================================================');
  console.log('Starting Zena Compiler Benchmark Suite');
  console.log(`Iterations per target: ${ITERATIONS}`);
  if (filter) {
    console.log(`Filter: ${filter}`);
  }
  console.log('==================================================\n');

  for (const target of targets) {
    console.log(`Running benchmarks for ${target.name}...`);

    const targetRuns = target.name === 'self_compile.zena' ? 1 : ITERATIONS;

    const bootOutWasm = join(outDir, `${target.name}.boot.wasm`);
    const selfOutWasm = join(outDir, `${target.name}.self.wasm`);

    // --- Benchmark Bootstrap Compiler ---
    const bootTimes: number[] = [];
    for (let i = 0; i < targetRuns; i++) {
      const t0 = performance.now();
      execSync(
        `node "${bootstrapCli}" build "${target.path}" --target wasi -o "${bootOutWasm}"`,
        {cwd: repoRoot, stdio: 'pipe'},
      );
      const t1 = performance.now();
      bootTimes.push(t1 - t0);
    }
    const bootMean = bootTimes.reduce((a, b) => a + b, 0) / targetRuns;

    // --- Benchmark Self-Hosted Compiler & Capture Timings ---
    const selfTimes: number[] = [];
    let totalFileLoad = 0;
    let totalPureParse = 0;
    let totalScope = 0;
    let totalCheck = 0;
    let totalCodegen = 0;
    let totalDiscovery = 0;
    let totalLayout = 0;
    let totalEmitCode = 0;
    let totalEmitOther = 0;
    let totalTime = 0;

    for (let i = 0; i < targetRuns; i++) {
      const t0 = performance.now();
      const output = execSync(
        `"${zenaCli}" build "${target.path}" -o "${selfOutWasm}" --time --no-cache`,
        {cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'},
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
        } else if (line.trim().startsWith('Discovery:')) {
          totalDiscovery += parseFloat(line.split(':')[1].trim());
        } else if (line.trim().startsWith('Layout:')) {
          totalLayout += parseFloat(line.split(':')[1].trim());
        } else if (line.trim().startsWith('Emit Code:')) {
          totalEmitCode += parseFloat(line.split(':')[1].trim());
        } else if (line.trim().startsWith('Emit Other:')) {
          totalEmitOther += parseFloat(line.split(':')[1].trim());
        } else if (line.startsWith('Total:')) {
          totalTime += parseFloat(line.split(':')[1].trim());
        }
      }
    }
    const selfMean = selfTimes.reduce((a, b) => a + b, 0) / targetRuns;
    const fileLoad = totalFileLoad / targetRuns;
    const pureParse = totalPureParse / targetRuns;
    const scope = totalScope / targetRuns;
    const check = totalCheck / targetRuns;
    const codegen = totalCodegen / targetRuns;
    const discovery = totalDiscovery / targetRuns;
    const layout = totalLayout / targetRuns;
    const emitCode = totalEmitCode / targetRuns;
    const emitOther = totalEmitOther / targetRuns;
    const meanTotalTime = totalTime / targetRuns;

    // --- Benchmark Self-Hosted Compiler in Node.js & Capture Timings ---
    const selfNodeTimes: number[] = [];
    let totalNodeFileLoad = 0;
    let totalNodePureParse = 0;
    let totalNodeScope = 0;
    let totalNodeCheck = 0;
    let totalNodeCodegen = 0;
    let totalNodeDiscovery = 0;
    let totalNodeLayout = 0;
    let totalNodeEmitCode = 0;
    let totalNodeEmitOther = 0;
    let totalNodeTime = 0;

    for (let i = 0; i < targetRuns; i++) {
      const t0 = performance.now();
      const output = execSync(
        `node --experimental-wasi-unstable-preview1 "${runCompilerNode}" "${target.path}" -o "${selfOutWasm}" --time`,
        {cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'},
      );
      const t1 = performance.now();
      selfNodeTimes.push(t1 - t0);

      // Parse timing lines like "File Load:  XX.XX ms"
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.startsWith('File Load:')) {
          totalNodeFileLoad += parseFloat(line.split(':')[1].trim());
        } else if (line.startsWith('Pure Parse:')) {
          totalNodePureParse += parseFloat(line.split(':')[1].trim());
        } else if (line.startsWith('Scope:')) {
          totalNodeScope += parseFloat(line.split(':')[1].trim());
        } else if (line.startsWith('Check:')) {
          totalNodeCheck += parseFloat(line.split(':')[1].trim());
        } else if (line.startsWith('Codegen:')) {
          totalNodeCodegen += parseFloat(line.split(':')[1].trim());
        } else if (line.trim().startsWith('Discovery:')) {
          totalNodeDiscovery += parseFloat(line.split(':')[1].trim());
        } else if (line.trim().startsWith('Layout:')) {
          totalNodeLayout += parseFloat(line.split(':')[1].trim());
        } else if (line.trim().startsWith('Emit Code:')) {
          totalNodeEmitCode += parseFloat(line.split(':')[1].trim());
        } else if (line.trim().startsWith('Emit Other:')) {
          totalNodeEmitOther += parseFloat(line.split(':')[1].trim());
        } else if (line.startsWith('Total:')) {
          totalNodeTime += parseFloat(line.split(':')[1].trim());
        }
      }
    }
    const selfNodeMean = selfNodeTimes.reduce((a, b) => a + b, 0) / targetRuns;
    const nodeFileLoad = totalNodeFileLoad / targetRuns;
    const nodePureParse = totalNodePureParse / targetRuns;
    const nodeScope = totalNodeScope / targetRuns;
    const nodeCheck = totalNodeCheck / targetRuns;
    const nodeCodegen = totalNodeCodegen / targetRuns;
    const nodeDiscovery = totalNodeDiscovery / targetRuns;
    const nodeLayout = totalNodeLayout / targetRuns;
    const nodeEmitCode = totalNodeEmitCode / targetRuns;
    const nodeEmitOther = totalNodeEmitOther / targetRuns;
    const meanNodeTotalTime = totalNodeTime / targetRuns;

    // --- Print Results ---
    console.log(`\nBenchmark Results for ${target.name}:`);

    const colWidths = [23, 20, 22, 20, 16, 18];
    const formatRow = (cells: string[]) => {
      return (
        '│ ' +
        cells
          .map((cell, i) => {
            if (i === 0) {
              return cell.padEnd(colWidths[i]);
            } else {
              return cell.padStart(colWidths[i]);
            }
          })
          .join(' │ ') +
        ' │'
      );
    };
    const makeSeparator = (left: string, mid: string, right: string) => {
      return left + colWidths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
    };

    console.log(makeSeparator('┌', '┬', '┐'));
    console.log(
      formatRow([
        'Metric',
        'Bootstrap (Node)',
        'Self-Hosted (Wasmtime)',
        'Self-Hosted (Node)',
        'Ratio (Wt/Boot)',
        'Ratio (Node/Boot)',
      ]),
    );
    console.log(makeSeparator('├', '┼', '┤'));
    console.log(
      formatRow([
        'Mean Compilation Time',
        `${bootMean.toFixed(2)} ms`,
        `${selfMean.toFixed(2)} ms`,
        `${selfNodeMean.toFixed(2)} ms`,
        `${(selfMean / bootMean).toFixed(2)}x`,
        `${(selfNodeMean / bootMean).toFixed(2)}x`,
      ]),
    );
    console.log(makeSeparator('└', '┴', '┘'));

    if (meanTotalTime > 0 || meanNodeTotalTime > 0) {
      console.log(
        `\nSelf-Hosted Internal Phase Breakdown (Mean of ${ITERATIONS} Runs):`,
      );
      const breakdownColWidths = [23, 22, 22];
      const formatBreakdownRow = (cells: string[]) => {
        return (
          '│ ' +
          cells
            .map((cell, i) => {
              if (i === 0) {
                return cell.padEnd(breakdownColWidths[i]);
              } else {
                return cell.padStart(breakdownColWidths[i]);
              }
            })
            .join(' │ ') +
          ' │'
        );
      };
      const makeBreakdownSeparator = (
        left: string,
        mid: string,
        right: string,
      ) => {
        return (
          left +
          breakdownColWidths.map((w) => '─'.repeat(w + 2)).join(mid) +
          right
        );
      };

      console.log(makeBreakdownSeparator('┌', '┬', '┐'));
      console.log(
        formatBreakdownRow([
          'Phase',
          'Wasmtime Execution',
          'Node.js Execution',
        ]),
      );
      console.log(makeBreakdownSeparator('├', '┼', '┤'));
      console.log(
        formatBreakdownRow([
          'File Load',
          `${fileLoad.toFixed(2)} ms`,
          `${nodeFileLoad.toFixed(2)} ms`,
        ]),
      );
      console.log(
        formatBreakdownRow([
          'Pure Parse',
          `${pureParse.toFixed(2)} ms`,
          `${nodePureParse.toFixed(2)} ms`,
        ]),
      );
      console.log(
        formatBreakdownRow([
          'Scope',
          `${scope.toFixed(2)} ms`,
          `${nodeScope.toFixed(2)} ms`,
        ]),
      );
      console.log(
        formatBreakdownRow([
          'Check',
          `${check.toFixed(2)} ms`,
          `${nodeCheck.toFixed(2)} ms`,
        ]),
      );
      console.log(
        formatBreakdownRow([
          'Codegen',
          `${codegen.toFixed(2)} ms`,
          `${nodeCodegen.toFixed(2)} ms`,
        ]),
      );

      console.log(
        formatBreakdownRow([
          '  Discovery',
          `${discovery.toFixed(2)} ms`,
          `${nodeDiscovery.toFixed(2)} ms`,
        ]),
      );
      console.log(
        formatBreakdownRow([
          '  Layout',
          `${layout.toFixed(2)} ms`,
          `${nodeLayout.toFixed(2)} ms`,
        ]),
      );
      console.log(
        formatBreakdownRow([
          '  Emit Code',
          `${emitCode.toFixed(2)} ms`,
          `${nodeEmitCode.toFixed(2)} ms`,
        ]),
      );
      console.log(
        formatBreakdownRow([
          '  Emit Other',
          `${emitOther.toFixed(2)} ms`,
          `${nodeEmitOther.toFixed(2)} ms`,
        ]),
      );
      console.log(makeBreakdownSeparator('├', '┼', '┤'));
      console.log(
        formatBreakdownRow([
          'Total Phase Time',
          `${meanTotalTime.toFixed(2)} ms`,
          `${meanNodeTotalTime.toFixed(2)} ms`,
        ]),
      );
      console.log(makeBreakdownSeparator('└', '┴', '┘'));
    }
    console.log('\n--------------------------------------------------\n');
  }
}

if (runStrings) {
  // --- String Execution Benchmarks ---
  console.log('==================================================');
  console.log('Running String Micro-Benchmark Suite (Execution)');
  if (filter) {
    console.log(`Filter: ${filter}`);
  }
  console.log('==================================================\n');

  const stringBenchSrc = join(benchmarksDir, 'string_bench.zena');
  const stringBenchWasm = join(outDir, 'string_bench.wasm');
  const stringBenchNode = join(
    pkgDir,
    'src',
    'scripts',
    'string-bench-node.js',
  );

  console.log('Compiling string_bench.zena...');
  try {
    execSync(
      `node "${bootstrapCli}" build "${stringBenchSrc}" --target wasi -o "${stringBenchWasm}"`,
      {cwd: repoRoot, stdio: 'pipe'},
    );
    console.log('Compilation successful.');
  } catch (e) {
    console.error('Failed to compile string_bench.zena:', e);
    process.exit(1);
  }

  console.log('\nRunning Zena (wasmtime via zena-cli) benchmark...');
  let zenaOut = '';
  try {
    const wasmFilterArg = filter ? ` -- "${filter}"` : '';
    zenaOut = execSync(
      `"${zenaCli}" run "${stringBenchWasm}"${wasmFilterArg}`,
      {cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'},
    );
  } catch (e) {
    console.error('Failed to run Zena benchmark:', e);
  }

  console.log('Running Zena (Node.js WASI) benchmark...');
  let zenaNodeOut = '';
  try {
    const wasmFilterArg = filter ? ` "${filter}"` : '';
    zenaNodeOut = execSync(
      `node --experimental-wasi-unstable-preview1 "${runWasiNode}" "${stringBenchWasm}"${wasmFilterArg}`,
      {cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'},
    );
  } catch (e) {
    console.error('Failed to run Zena Node.js benchmark:', e);
  }

  console.log('Running Node.js (V8 JS) benchmark...');
  let nodeOut = '';
  try {
    const nodeFilterArg = filter ? ` "${filter}"` : '';
    nodeOut = execSync(`node "${stringBenchNode}"${nodeFilterArg}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (e) {
    console.error('Failed to run Node.js benchmark:', e);
  }

  // Parse timing data
  const parseTimes = (output: string) => {
    const map = new Map<string, number>();
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes(':') && line.includes('ms')) {
        const parts = line.split(':');
        const name = parts[0].trim();
        const time = parseFloat(parts[1].replace('ms', '').trim());
        if (name && !isNaN(time)) {
          map.set(name, time);
        }
      }
    }
    return map;
  };

  const zenaTimes = parseTimes(zenaOut);
  const zenaNodeTimes = parseTimes(zenaNodeOut);
  const nodeTimes = parseTimes(nodeOut);

  // If any are run, display table
  if (zenaTimes.size > 0 || zenaNodeTimes.size > 0 || nodeTimes.size > 0) {
    console.log('\nString Micro-Benchmark Comparison:');
    const stringColWidths = [40, 17, 17, 16, 15, 15];
    const formatStringRow = (cells: string[]) => {
      return (
        '│ ' +
        cells
          .map((cell, i) => {
            if (i === 0) {
              return cell.padEnd(stringColWidths[i]);
            } else {
              return cell.padStart(stringColWidths[i]);
            }
          })
          .join(' │ ') +
        ' │'
      );
    };
    const makeStringSeparator = (left: string, mid: string, right: string) => {
      return (
        left + stringColWidths.map((w) => '─'.repeat(w + 2)).join(mid) + right
      );
    };

    console.log(makeStringSeparator('┌', '┬', '┐'));
    console.log(
      formatStringRow([
        'Test Case',
        'Zena (Wasmtime)',
        'Zena (Node.js)',
        'Node.js (JS)',
        'Ratio (Wt/JS)',
        'Ratio (Node/JS)',
      ]),
    );
    console.log(makeStringSeparator('├', '┼', '┤'));

    for (const [name, zenaTime] of zenaTimes.entries()) {
      const zenaNodeTime = zenaNodeTimes.get(name);
      const nodeTime = nodeTimes.get(name);
      if (nodeTime !== undefined && zenaNodeTime !== undefined) {
        const wtRatio = `${(zenaTime / nodeTime).toFixed(2)}x`;
        const nodeRatio = `${(zenaNodeTime / nodeTime).toFixed(2)}x`;
        console.log(
          formatStringRow([
            name,
            `${zenaTime.toFixed(2)} ms`,
            `${zenaNodeTime.toFixed(2)} ms`,
            `${nodeTime.toFixed(2)} ms`,
            wtRatio,
            nodeRatio,
          ]),
        );
      }
    }
    console.log(makeStringSeparator('└', '┴', '┘'));

    // --- Print Dedicated Concatenation Techniques Comparison Table ---
    const compareKeys = [
      {key: 'CompareConcatPlus (N=100,000)', name: 'Operator +'},
      {key: 'CompareTemplateLiteral (N=100,000)', name: 'Template Literal'},
      {key: 'CompareStringBuilderNew (N=100,000)', name: 'StringBuilder (New)'},
      {
        key: 'CompareStringBuilderFromString (N=100,000)',
        name: 'StringBuilder (from)',
      },
      {key: 'CompareStringFromParts (N=100,000)', name: 'String.fromParts'},
    ];

    const hasComparisons = compareKeys.every(
      (k) =>
        zenaTimes.has(k.key) &&
        zenaNodeTimes.has(k.key) &&
        nodeTimes.has(k.key),
    );
    if (hasComparisons) {
      console.log('\nConcatenation Techniques Comparison (N=100,000):');
      const compareColWidths = [24, 17, 17, 16, 20];
      const formatCompareRow = (cells: string[]) => {
        return (
          '│ ' +
          cells
            .map((cell, i) => {
              if (i === 0) {
                return cell.padEnd(compareColWidths[i]);
              } else {
                return cell.padStart(compareColWidths[i]);
              }
            })
            .join(' │ ') +
          ' │'
        );
      };
      const makeCompareSeparator = (
        left: string,
        mid: string,
        right: string,
      ) => {
        return (
          left +
          compareColWidths.map((w) => '─'.repeat(w + 2)).join(mid) +
          right
        );
      };

      console.log(makeCompareSeparator('┌', '┬', '┐'));
      console.log(
        formatCompareRow([
          'Technique',
          'Zena (Wasmtime)',
          'Zena (Node.js)',
          'Node.js (JS)',
          'Speedup vs + (Wt)',
        ]),
      );
      console.log(makeCompareSeparator('├', '┼', '┤'));

      const plusTimeWt = zenaTimes.get('CompareConcatPlus (N=100,000)')!;
      for (const {key, name} of compareKeys) {
        const wtTime = zenaTimes.get(key)!;
        const nodeTime = zenaNodeTimes.get(key)!;
        const jsTime = nodeTimes.get(key)!;
        const speedup = `${(plusTimeWt / wtTime).toFixed(2)}x`;

        console.log(
          formatCompareRow([
            name,
            `${wtTime.toFixed(2)} ms`,
            `${nodeTime.toFixed(2)} ms`,
            `${jsTime.toFixed(2)} ms`,
            speedup,
          ]),
        );
      }
      console.log(makeCompareSeparator('└', '┴', '┘'));
    }
  } else {
    console.log('\nNo matching string benchmarks were run.');
  }
  console.log('\n--------------------------------------------------\n');
}

if (runBasic) {
  // --- Basic Execution Benchmarks ---
  console.log('==================================================');
  console.log('Running Basic Micro-Benchmark Suite (Execution)');
  if (filter) {
    console.log(`Filter: ${filter}`);
  }
  console.log('==================================================\n');

  const basicBenchSrc = join(benchmarksDir, 'basic_bench.zena');
  const basicBenchWasm = join(outDir, 'basic_bench.wasm');
  const basicBenchNode = join(pkgDir, 'src', 'scripts', 'basic-bench-node.js');

  console.log('Compiling basic_bench.zena...');
  try {
    execSync(
      `node "${bootstrapCli}" build "${basicBenchSrc}" --target wasi -o "${basicBenchWasm}"`,
      {cwd: repoRoot, stdio: 'pipe'},
    );
    console.log('Compilation successful.');
  } catch (e) {
    console.error('Failed to compile basic_bench.zena:', e);
    process.exit(1);
  }

  console.log('\nRunning Zena (wasmtime via zena-cli) benchmark...');
  let zenaOut = '';
  try {
    const wasmFilterArg = filter ? ` -- "${filter}"` : '';
    zenaOut = execSync(`"${zenaCli}" run "${basicBenchWasm}"${wasmFilterArg}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (e) {
    console.error('Failed to run Zena benchmark:', e);
  }

  console.log('Running Zena (Node.js WASI) benchmark...');
  let zenaNodeOut = '';
  try {
    const wasmFilterArg = filter ? ` "${filter}"` : '';
    zenaNodeOut = execSync(
      `node --experimental-wasi-unstable-preview1 "${runWasiNode}" "${basicBenchWasm}"${wasmFilterArg}`,
      {cwd: repoRoot, encoding: 'utf-8', stdio: 'pipe'},
    );
  } catch (e) {
    console.error('Failed to run Zena Node.js benchmark:', e);
  }

  console.log('Running Node.js (V8 JS) benchmark...');
  let nodeOut = '';
  try {
    const nodeFilterArg = filter ? ` "${filter}"` : '';
    nodeOut = execSync(`node "${basicBenchNode}"${nodeFilterArg}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (e) {
    console.error('Failed to run Node.js benchmark:', e);
  }

  // Parse timing data
  const parseTimes = (output: string) => {
    const map = new Map<string, number>();
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes(':') && line.includes('ms')) {
        const parts = line.split(':');
        const name = parts[0].trim();
        const time = parseFloat(parts[1].replace('ms', '').trim());
        if (name && !isNaN(time)) {
          map.set(name, time);
        }
      }
    }
    return map;
  };

  const zenaTimes = parseTimes(zenaOut);
  const zenaNodeTimes = parseTimes(zenaNodeOut);
  const nodeTimes = parseTimes(nodeOut);

  // If any are run, display table
  if (zenaTimes.size > 0 || zenaNodeTimes.size > 0 || nodeTimes.size > 0) {
    const colWidths = [42, 17, 17, 16, 15, 15];
    const formatRow = (cells: string[]) => {
      return (
        '│ ' +
        cells
          .map((cell, i) => {
            if (i === 0) {
              return cell.padEnd(colWidths[i]);
            } else {
              return cell.padStart(colWidths[i]);
            }
          })
          .join(' │ ') +
        ' │'
      );
    };
    const makeSeparator = (left: string, mid: string, right: string) => {
      return left + colWidths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
    };

    const categories = [
      {
        title: 'Control Flow & Recursion',
        cases: [
          {key: 'FibonacciRecursive35', name: 'Fibonacci Recursive (N=35)'},
          {key: 'FibonacciRecursive40', name: 'Fibonacci Recursive (N=40)'},
          {
            key: 'FibonacciIterative (N=10,000,000)',
            name: 'Fibonacci Iterative (N=10M)',
          },
        ],
      },
      {
        title: 'Direct & Indirect Function Calls (N=10,000,000)',
        cases: [
          {
            key: 'FunctionCallSimple (N=10,000,000)',
            name: 'Direct Call (simple/inlinable)',
          },
          {
            key: 'FunctionCallNoInline (N=10,000,000)',
            name: 'Direct Call (non-inlinable)',
          },
          {
            key: 'FunctionCallClosure (N=10,000,000)',
            name: 'Indirect Closure Call',
          },
        ],
      },
      {
        title: 'Looping & Iteration (N=10,000,000 elements)',
        cases: [
          {key: 'LoopForLoop (N=10,000,000)', name: 'C-style index for-loop'},
          {key: 'LoopWhileArray (N=10,000,000)', name: 'while-loop / array'},
          {
            key: 'LoopForInArray (N=10,000,000)',
            name: 'for-in / array',
          },
          {
            key: 'LoopForInArrayInterface (N=10,000,000)',
            name: 'for-in / array (interface)',
          },
          {
            key: 'LoopForInGrowableArray (N=10,000,000)',
            name: 'for-in / growable array',
          },
          {
            key: 'LoopForInGrowableArrayInterface (N=10,000,000)',
            name: 'for-in / growable array (interface)',
          },
          {
            key: 'LoopForInImmutableArray (N=10,000,000)',
            name: 'for-in / immutable array',
          },
          {
            key: 'LoopForInImmutableArrayInterface (N=10,000,000)',
            name: 'for-in / immutable array (interface)',
          },
          {
            key: 'LoopForInCustom (N=10,000,000)',
            name: 'for-in / custom collection',
          },
        ],
      },
      {
        title: 'Type Casting (N=10,000,000)',
        cases: [
          {key: 'CastDirectAccess (N=10,000,000)', name: 'Direct Field Access'},
          {
            key: 'CastWithCastAccess (N=10,000,000)',
            name: 'Cast Field Access (as String)',
          },
        ],
      },
      {
        title: 'Field Access (N=10,000,000)',
        cases: [
          {
            key: 'FieldAccessVirtual (N=10,000,000)',
            name: 'Virtual Dispatch',
          },
          {
            key: 'FieldAccessDevirtFinal (N=10,000,000)',
            name: 'Devirtualized (Final Class)',
          },
          {
            key: 'FieldAccessDevirtFinalField (N=10,000,000)',
            name: 'Devirtualized (Final Field)',
          },
          {
            key: 'FieldAccessDevirtEffectivelyFinal (N=10,000,000)',
            name: 'Devirtualized (Effectively Final)',
          },
          {
            key: 'FieldAccessRecordNoAdapt (N=10,000,000)',
            name: 'Record (No Adaptation)',
          },
          {
            key: 'FieldAccessRecordAdapt (N=10,000,000)',
            name: 'Record (Adaptation)',
          },
        ],
      },
      {
        title: 'Field Assignment (N=10,000,000)',
        cases: [
          {
            key: 'FieldAssignVirtual (N=10,000,000)',
            name: 'Virtual Dispatch',
          },
          {
            key: 'FieldAssignDevirtFinal (N=10,000,000)',
            name: 'Devirtualized (Final Class)',
          },
          {
            key: 'FieldAssignDevirtFinalField (N=10,000,000)',
            name: 'Devirtualized (Final Field)',
          },
          {
            key: 'FieldAssignDevirtEffectivelyFinal (N=10,000,000)',
            name: 'Devirtualized (Effectively Final)',
          },
        ],
      },
      {
        title: 'Method Devirtualization (N=10,000,000)',
        cases: [
          {
            key: 'DevirtNoInferCall (N=10,000,000)',
            name: 'Dynamic (non-devirtualizable)',
          },
          {
            key: 'DevirtInferCall (N=10,000,000)',
            name: 'Dynamic (devirtualizable)',
          },
          {
            key: 'DevirtNoInferOverrideCall (N=10,000,000)',
            name: 'Override Dynamic (non-devirt)',
          },
          {
            key: 'DevirtInferOverrideCall (N=10,000,000)',
            name: 'Override Dynamic (devirtualized)',
          },
          {
            key: 'DevirtStaticCall (N=10,000,000)',
            name: 'Static (devirtualized)',
          },
        ],
      },
      {
        title: 'Pattern Matching vs is/else (N=10,000,000)',
        cases: [
          {key: 'MatchSingle (N=10,000,000)', name: 'match (single case)'},
          {key: 'IfSingle (N=10,000,000)', name: 'is check with if/else'},
          {key: 'Match3Case (N=10,000,000)', name: 'match (3 cases)'},
          {
            key: 'If3Case (N=10,000,000)',
            name: 'is checks with if/else (3 cases)',
          },
        ],
      },
    ];

    for (const cat of categories) {
      // Check if any case in this category was run
      const matchingCases = cat.cases.filter((c) => zenaTimes.has(c.key));
      if (matchingCases.length === 0) {
        continue;
      }

      console.log(`\nCategory: ${cat.title}`);
      console.log(makeSeparator('┌', '┬', '┐'));
      console.log(
        formatRow([
          'Test Case',
          'Zena (Wasmtime)',
          'Zena (Node)',
          'JS (Node)',
          'Ratio (Wt/JS)',
          'Ratio (Node/JS)',
        ]),
      );
      console.log(makeSeparator('├', '┼', '┤'));

      for (const c of cat.cases) {
        const zenaTime = zenaTimes.get(c.key);
        const zenaNodeTime = zenaNodeTimes.get(c.key);
        const nodeTime = nodeTimes.get(c.key);
        if (
          zenaTime !== undefined &&
          zenaNodeTime !== undefined &&
          nodeTime !== undefined
        ) {
          const wtRatio = `${(zenaTime / nodeTime).toFixed(2)}x`;
          const nodeRatio = `${(zenaNodeTime / nodeTime).toFixed(2)}x`;
          console.log(
            formatRow([
              c.name,
              `${zenaTime.toFixed(2)} ms`,
              `${zenaNodeTime.toFixed(2)} ms`,
              `${nodeTime.toFixed(2)} ms`,
              wtRatio,
              nodeRatio,
            ]),
          );
        }
      }
      console.log(makeSeparator('└', '┴', '┘'));
    }
  } else {
    console.log('\nNo matching basic benchmarks were run.');
  }
  console.log('\n--------------------------------------------------\n');
}
