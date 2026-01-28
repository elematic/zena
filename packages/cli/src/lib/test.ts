import {Compiler, CodeGenerator} from '@zena-lang/compiler';
import {instantiate} from '@zena-lang/runtime';
import {resolve, relative, dirname, basename} from 'node:path';
import {NodeCompilerHost} from './host.js';
import {glob} from 'glob';

// Zena test result structures (mirroring zena:test)
export interface ZenaTestResult {
  name: string;
  passed: boolean;
  error: string | null;
}

export interface ZenaSuiteResult {
  name: string;
  tests: ZenaTestResult[];
  suites: ZenaSuiteResult[];
  passed: number;
  failed: number;
}

export interface TestResult {
  file: string;
  passed: boolean;
  error?: string;
  duration: number;
  suiteResult?: ZenaSuiteResult;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  duration: number;
  results: TestResult[];
}

export interface TestRunnerOptions {
  /** Glob patterns for test files */
  patterns: string[];
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** Verbose output */
  verbose?: boolean;
}

/**
 * Read a string from WASM using the standard byte-reading pattern.
 * The string getter returns a struct with length accessible via $stringGetByte.
 */
const readWasmString = (
  exports: WebAssembly.Exports,
  getter: () => unknown,
): string => {
  const stringRef = getter();
  if (stringRef === null || stringRef === undefined) {
    return '';
  }
  // Use the runtime's string reading pattern
  // The export is $stringGetLength, not $stringLen
  const $stringGetLength = exports.$stringGetLength as (s: unknown) => number;
  const $stringGetByte = exports.$stringGetByte as (
    s: unknown,
    i: number,
  ) => number;

  if (!$stringGetLength || !$stringGetByte) {
    return '';
  }

  const length = $stringGetLength(stringRef);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = $stringGetByte(stringRef, i) & 0xff;
  }
  return new TextDecoder().decode(bytes);
};

/**
 * Read suite results from WASM exports using accessor functions.
 * This avoids string concatenation in Zena by letting JS build the result.
 */
const readSuiteResult = (
  exports: WebAssembly.Exports,
): ZenaSuiteResult | null => {
  const getSuiteName = exports.getSuiteName as (() => unknown) | undefined;
  const getSuitePassed = exports.getSuitePassed as (() => number) | undefined;
  const getSuiteFailed = exports.getSuiteFailed as (() => number) | undefined;
  const getTestCount = exports.getTestCount as (() => number) | undefined;
  const getNestedSuiteCount = exports.getNestedSuiteCount as
    | (() => number)
    | undefined;
  const getTestName = exports.getTestName as
    | ((i: number) => unknown)
    | undefined;
  const getTestPassed = exports.getTestPassed as
    | ((i: number) => boolean)
    | undefined;
  const getTestError = exports.getTestError as
    | ((i: number) => unknown)
    | undefined;
  const selectNestedSuite = exports.selectNestedSuite as
    | ((i: number) => void)
    | undefined;
  const getNestedSuiteName = exports.getNestedSuiteName as
    | (() => unknown)
    | undefined;
  const getNestedSuitePassed = exports.getNestedSuitePassed as
    | (() => number)
    | undefined;
  const getNestedSuiteFailed = exports.getNestedSuiteFailed as
    | (() => number)
    | undefined;
  const getNestedTestCount = exports.getNestedTestCount as
    | (() => number)
    | undefined;
  const getNestedTestName = exports.getNestedTestName as
    | ((i: number) => unknown)
    | undefined;
  const getNestedTestPassed = exports.getNestedTestPassed as
    | ((i: number) => boolean)
    | undefined;
  const getNestedTestError = exports.getNestedTestError as
    | ((i: number) => unknown)
    | undefined;

  if (!getSuiteName || !getSuitePassed || !getSuiteFailed || !getTestCount) {
    return null;
  }

  // Read root suite
  const tests: ZenaTestResult[] = [];
  const testCount = getTestCount();
  for (let i = 0; i < testCount; i++) {
    const name = getTestName
      ? readWasmString(exports, () => getTestName(i))
      : '';
    const passed = getTestPassed ? getTestPassed(i) : false;
    const errorRef = getTestError ? getTestError(i) : null;
    const error =
      errorRef !== null ? readWasmString(exports, () => errorRef) : null;
    tests.push({name, passed, error});
  }

  // Read nested suites (one level deep for now)
  const suites: ZenaSuiteResult[] = [];
  const nestedCount = getNestedSuiteCount ? getNestedSuiteCount() : 0;
  for (let i = 0; i < nestedCount; i++) {
    if (selectNestedSuite) {
      selectNestedSuite(i);
    }

    const nestedTests: ZenaTestResult[] = [];
    const nestedTestCount = getNestedTestCount ? getNestedTestCount() : 0;
    for (let j = 0; j < nestedTestCount; j++) {
      const name = getNestedTestName
        ? readWasmString(exports, () => getNestedTestName!(j))
        : '';
      const passed = getNestedTestPassed ? getNestedTestPassed(j) : false;
      const errorRef = getNestedTestError ? getNestedTestError(j) : null;
      const error =
        errorRef !== null ? readWasmString(exports, () => errorRef) : null;
      nestedTests.push({name, passed, error});
    }

    suites.push({
      name: getNestedSuiteName
        ? readWasmString(exports, () => getNestedSuiteName!())
        : '',
      tests: nestedTests,
      suites: [], // Only one level deep for now
      passed: getNestedSuitePassed ? getNestedSuitePassed() : 0,
      failed: getNestedSuiteFailed ? getNestedSuiteFailed() : 0,
    });
  }

  return {
    name: readWasmString(exports, () => getSuiteName()),
    tests,
    suites,
    passed: getSuitePassed(),
    failed: getSuiteFailed(),
  };
};

/**
 * Format a suite result tree for display (spec reporter style).
 * Always prints test results, not just in verbose mode.
 */
const printSuiteResult = (
  result: ZenaSuiteResult,
  file: string,
  indent: number,
): void => {
  const prefix = '  '.repeat(indent);
  const icon = result.failed > 0 ? '✖' : '✔';

  if (indent === 0) {
    // Root level - show file path with icon
    console.log(`${icon} ${file}`);
  } else {
    // Nested suite - show name with icon
    console.log(`${prefix}▶ ${result.name}`);
  }

  // Print test results
  for (const test of result.tests) {
    const testIcon = test.passed ? '✔' : '✖';
    const testPrefix = '  '.repeat(indent + 1);
    console.log(`${testPrefix}${testIcon} ${test.name}`);
    if (!test.passed && test.error) {
      console.log(`${testPrefix}    ${test.error}`);
    }
  }

  // Print nested suites
  for (const suite of result.suites) {
    printSuiteResult(suite, file, indent + 1);
  }
};

/**
 * Format failures for error message.
 */
const formatFailures = (result: ZenaSuiteResult): string => {
  const failures: string[] = [];

  const collectFailures = (suite: ZenaSuiteResult, path: string[]): void => {
    for (const test of suite.tests) {
      if (!test.passed) {
        const fullName = [...path, test.name].join(' > ');
        failures.push(`  ✖ ${fullName}${test.error ? `: ${test.error}` : ''}`);
      }
    }
    for (const nested of suite.suites) {
      collectFailures(nested, [...path, nested.name]);
    }
  };

  collectFailures(result, [result.name]);
  return `${result.failed} test(s) failed:\n${failures.join('\n')}`;
};

/**
 * Compile and run a single test file.
 *
 * Test files can either:
 * 1. Export a `main` function that runs tests and returns 0 on success
 * 2. Export a `tests` Suite variable - the runner will auto-generate main
 *
 * If neither is found but the file compiles, it's considered a pass.
 */
const runTestFile = async (filePath: string): Promise<TestResult> => {
  const start = performance.now();

  try {
    const host = new NodeCompilerHost();
    const compiler = new Compiler(host);

    // First, compile the test file to check for exports
    const modules = compiler.compile(filePath);

    // Check for compilation errors
    for (const mod of modules) {
      if (mod.diagnostics.length > 0) {
        const errors = mod.diagnostics
          .map((d) => {
            const loc = d.location
              ? ` at line ${d.location.line}, column ${d.location.column}`
              : '';
            return `${d.message}${loc}`;
          })
          .join('\n');
        return {
          file: filePath,
          passed: false,
          error: `Compilation errors:\n${errors}`,
          duration: performance.now() - start,
        };
      }
    }

    // Check if the main module has a 'main' export or 'tests' export
    const mainModule = modules.find((m) => m.path === filePath);
    const hasMainExport = mainModule?.exports?.has('value:main') ?? false;
    const hasTestsExport = mainModule?.exports?.has('value:tests') ?? false;

    let entryPoint = filePath;
    let compiledModules = modules;
    let useStructuredResults = false;

    if (!hasMainExport && hasTestsExport) {
      // Generate a wrapper that imports tests and exposes accessors for results.
      // We can't build JSON in Zena (no string concat yet), so the wrapper
      // exports functions that let JS traverse the result tree.
      //
      // IMPORTANT: Reuse the same host and compiler to share semantic context.
      // Using a new Compiler would create a new CheckerContext with empty bindings,
      // and the second compile() call would skip already-checked modules.

      const testFileName = basename(filePath);
      const wrapperPath = filePath.replace(/\.zena$/, '.__wrapper__.zena');
      // Wrapper stores the result and provides accessor functions.
      // We use a non-null type for the result and initialize in main().
      // Accessors will only be called after main() completes.
      const wrapperSource = `
import { tests } from './${testFileName}';
import { SuiteResult, TestResult } from 'zena:test';
import { Array } from 'zena:growable-array';

// The result - will be initialized by main() before any accessors are called
var _result: SuiteResult | null = null;

// Helper to get result safely (will always succeed after main())
let result = (): SuiteResult => {
  // After main() runs, _result is always non-null
  if (_result !== null) {
    return _result;
  }
  // Should never happen, but return a dummy to satisfy type checker
  return new SuiteResult('');
};

export let main = (): i32 => {
  _result = tests.run();
  if (_result !== null) {
    return _result.failed;
  }
  return 0;
};

// Suite accessors - call result() which handles null check
export let getSuiteName = (): string => result().name;
export let getSuitePassed = (): i32 => result().passed;
export let getSuiteFailed = (): i32 => result().failed;
export let getTestCount = (): i32 => result().tests.length;
export let getNestedSuiteCount = (): i32 => result().suites.length;

// Test result accessors (by index)
export let getTestName = (index: i32): string => result().tests[index].name;
export let getTestPassed = (index: i32): boolean => result().tests[index].passed;
export let getTestError = (index: i32): string | null => result().tests[index].error;

// Nested suite accessors
var currentNestedSuite: SuiteResult | null = null;

export let selectNestedSuite = (index: i32): void => {
  currentNestedSuite = result().suites[index];
};

let nested = (): SuiteResult => {
  if (currentNestedSuite !== null) {
    return currentNestedSuite;
  }
  return new SuiteResult('');
};

export let getNestedSuiteName = (): string => nested().name;
export let getNestedSuitePassed = (): i32 => nested().passed;
export let getNestedSuiteFailed = (): i32 => nested().failed;
export let getNestedTestCount = (): i32 => nested().tests.length;
export let getNestedTestName = (index: i32): string => nested().tests[index].name;
export let getNestedTestPassed = (index: i32): boolean => nested().tests[index].passed;
export let getNestedTestError = (index: i32): string | null => nested().tests[index].error;
`;
      // Register the virtual wrapper file on the SAME host
      host.registerVirtualFile(wrapperPath, wrapperSource);

      // Compile with the wrapper as entry point using the SAME compiler
      const wrapperModules = compiler.compile(wrapperPath);

      // Check for errors in wrapper compilation
      for (const mod of wrapperModules) {
        if (mod.diagnostics.length > 0) {
          const errors = mod.diagnostics
            .map((d) => {
              const loc = d.location
                ? ` at line ${d.location.line}, column ${d.location.column}`
                : '';
              return `${d.message}${loc}`;
            })
            .join('\n');
          return {
            file: filePath,
            passed: false,
            error: `Wrapper compilation errors:\n${errors}`,
            duration: performance.now() - start,
          };
        }
      }

      // Use the wrapper modules
      compiledModules = wrapperModules;
      entryPoint = wrapperPath;
      useStructuredResults = true;
    }

    // Pass the compiler's semantic context to codegen so it can access resolved bindings
    const codegen = new CodeGenerator(
      compiledModules,
      entryPoint,
      compiler.semanticContext,
      compiler.checkerContext,
    );
    const bytes = codegen.generate();

    // Instantiate
    const result = await instantiate(bytes);
    const instance =
      result instanceof WebAssembly.Instance
        ? result
        : (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
    const exports = instance.exports;

    // Run tests - look for main()
    const mainFn = exports.main as (() => number) | undefined;

    if (typeof mainFn === 'function') {
      const exitCode = mainFn();

      // Check if we have structured result accessors (from wrapper)
      if (useStructuredResults) {
        const suiteResult = readSuiteResult(exports);

        if (suiteResult) {
          return {
            file: filePath,
            passed: exitCode === 0,
            error: exitCode !== 0 ? formatFailures(suiteResult) : undefined,
            duration: performance.now() - start,
            suiteResult,
          };
        }
      }

      return {
        file: filePath,
        passed: exitCode === 0,
        error:
          exitCode !== 0 ? `Test returned exit code ${exitCode}` : undefined,
        duration: performance.now() - start,
      };
    }

    // No main function found - consider it a pass if it compiled and instantiated
    return {
      file: filePath,
      passed: true,
      duration: performance.now() - start,
    };
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    // Check for WASM exception reference error
    if (errorMessage.includes('--experimental-wasm-exnref')) {
      return {
        file: filePath,
        passed: false,
        error: `WASM exception handling requires Node.js flag:\n  node --experimental-wasm-exnref <command>`,
        duration: performance.now() - start,
      };
    }
    return {
      file: filePath,
      passed: false,
      error: errorMessage,
      duration: performance.now() - start,
    };
  }
};

/**
 * Format duration for display
 */
const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
};

/**
 * Run all tests matching the given patterns.
 */
export const runTests = async (
  options: TestRunnerOptions,
): Promise<TestSummary> => {
  const cwd = options.cwd ?? process.cwd();
  const verbose = options.verbose ?? false;

  // Find test files
  const files: string[] = [];
  for (const pattern of options.patterns) {
    const matches = await glob(pattern, {cwd, absolute: true});
    files.push(...matches);
  }

  // Deduplicate
  const uniqueFiles = [...new Set(files)];

  if (uniqueFiles.length === 0) {
    console.log('No test files found.');
    return {
      total: 0,
      passed: 0,
      failed: 0,
      duration: 0,
      results: [],
    };
  }

  console.log(`\nRunning ${uniqueFiles.length} test file(s)...\n`);

  const results: TestResult[] = [];
  const overallStart = performance.now();

  for (const file of uniqueFiles) {
    const displayPath = relative(cwd, file);

    const result = await runTestFile(file);
    results.push(result);

    // Print results - always show structured results if available
    if (result.suiteResult) {
      printSuiteResult(result.suiteResult, displayPath, 0);
      if (verbose) {
        console.log(`  (${formatDuration(result.duration)})`);
      }
    } else if (result.passed) {
      console.log(`✔ ${displayPath}`);
    } else {
      console.log(`✖ ${displayPath}`);
      if (result.error) {
        console.log(`    ${result.error.split('\n').join('\n    ')}`);
      }
    }
  }

  const overallDuration = performance.now() - overallStart;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  // Summary
  console.log('');
  console.log('─'.repeat(50));
  if (failed === 0) {
    console.log(
      `✓ ${passed} test file(s) passed (${formatDuration(overallDuration)})`,
    );
  } else {
    console.log(
      `✗ ${failed} failed, ${passed} passed (${formatDuration(overallDuration)})`,
    );
  }

  return {
    total: uniqueFiles.length,
    passed,
    failed,
    duration: overallDuration,
    results,
  };
};

/**
 * CLI entry point for the test command.
 */
export const testCommand = async (
  patterns: string[],
  options: {verbose?: boolean} = {},
): Promise<number> => {
  if (patterns.length === 0) {
    // Default pattern
    patterns = ['**/*_test.zena'];
  }

  const summary = await runTests({
    patterns,
    verbose: options.verbose,
  });

  return summary.failed > 0 ? 1 : 0;
};
