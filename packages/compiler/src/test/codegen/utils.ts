import {execSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Module} from '../../lib/ast.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {Compiler, type CompilerHost} from '../../lib/compiler.js';
import {DiagnosticSeverity, type Diagnostic} from '../../lib/diagnostics.js';
import {Parser} from '../../lib/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// When running compiled tests, we are in packages/compiler/test/codegen
// Stdlib is in packages/stdlib/zena
export const stdlibPath = join(__dirname, '../../../stdlib/zena');

/**
 * Parse source code and wrap it as a single-module array for CodeGenerator.
 * Use this for low-level codegen tests that bypass the full compiler pipeline.
 *
 * @param source - Source code to parse
 * @param path - Path for the module (default: '/test.zena')
 * @returns An array with a single Module
 */
export const parseAsModule = (
  source: string,
  path = '/test.zena',
): Module[] => {
  const parser = new Parser(source, {path, isStdlib: false});
  const ast = parser.parse();
  return [ast];
};

export interface CompileOptions {
  entryPoint?: string;
  imports?: Record<string, any>;
  path?: string;
}

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

/**
 * Create a standard compiler host for test files.
 * @param files - Map of file paths to source code, or a single source string (uses /main.zena)
 * @param mainPath - Path for single source string input (default: /main.zena)
 */
export const createHost = (
  files: string | Record<string, string>,
  mainPath = '/main.zena',
): CompilerHost => ({
  load: (p: string) => {
    if (typeof files === 'string') {
      if (p === mainPath) return files;
    } else if (Object.hasOwn(files, p)) {
      return files[p];
    }
    if (p.startsWith('zena:')) {
      const name = p.substring(5);
      return readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
    }
    throw new Error(`File not found: ${p}`);
  },
  resolve: (specifier: string, _referrer: string) => {
    // zena:console is virtual - map to console-host for host target
    if (specifier === 'zena:console') {
      return 'zena:console-host';
    }
    return specifier;
  },
});

/**
 * Compile source to a bundled program and return diagnostics.
 * Useful for checker tests that need to verify type errors.
 */
export const checkSource = (
  input: string | Record<string, string>,
  path = '/main.zena',
): Diagnostic[] => {
  const host = createHost(input, path);
  const compiler = new Compiler(host);
  // compile() runs type checking on all modules
  const modules = compiler.compile(path);
  // Collect diagnostics from all modules
  return modules.flatMap((m) => m.diagnostics ?? []);
};

/**
 * Compile source and return modules with their diagnostics.
 * Useful for tests that need to check per-module diagnostics from the initial compile pass.
 */
export const compileModules = (
  input: string | Record<string, string>,
  path = '/main.zena',
): Module[] => {
  const host = createHost(input, path);
  const compiler = new Compiler(host);
  return compiler.compile(path);
};

/**
 * Options for compileToWasm.
 */
export interface CompileToWasmOptions {
  /** Enable dead code elimination */
  dce?: boolean;
}

/**
 * Compile source to WASM bytes without instantiating.
 * Useful for tests that compare binary output or check WASM structure.
 */
export const compileToWasm = (
  input: string | Record<string, string>,
  path = '/main.zena',
  options: CompileToWasmOptions = {},
): Uint8Array => {
  const host = createHost(input, path);
  const compiler = new Compiler(host);
  const modules = compiler.compile(path);
  const generator = new CodeGenerator(
    modules,
    path,
    compiler.semanticContext,
    compiler.checkerContext,
    {dce: options.dce},
  );
  return generator.generate();
};

export async function compileAndInstantiate(
  input: string | Record<string, string>,
  options: CompileOptions = {},
): Promise<any> {
  const path = options.path ?? '/main.zena';
  const imports = options.imports ?? {};

  let capturedExports: any = null;

  // Add default console mock if not present
  if (!imports.console) {
    const logString = (s: any, len: number) => {
      if (!capturedExports || !capturedExports.$stringGetByte) return;
      let str = '';
      for (let i = 0; i < len; i++) {
        const code = capturedExports.$stringGetByte(s, i);
        str += String.fromCharCode(code);
      }
      console.log(str);
    };

    imports.console = {
      log_i32: (v: number) => console.log(v),
      log_f32: (v: number) => console.log(v),
      log_string: logString,
      error_string: logString,
      warn_string: logString,
      info_string: logString,
      debug_string: logString,
    };
  }

  const host = createHost(input, path);

  const compiler = new Compiler(host);

  // Check for errors from the initial compilation pass
  const modules = compiler.compile(path);
  const allDiagnostics = modules.flatMap((m) => m.diagnostics ?? []);
  const errors = allDiagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      `Compilation failed: ${errors.map((d) => d.message).join(', ')}`,
    );
  }

  const codegen = new CodeGenerator(
    modules,
    path,
    compiler.semanticContext,
    compiler.checkerContext,
  );
  const bytes = codegen.generate();

  try {
    const result = await WebAssembly.instantiate(bytes, imports);
    const instance = (result as any).instance || result;
    capturedExports = instance.exports;
    return instance.exports;
  } catch (e) {
    console.log('WASM Instantiation Error:', e);
    try {
      // Try to convert to WAT using wasm2wat
      const wat = execSync('wasm2wat - --enable-all', {
        input: bytes,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log('WASM Text (WAT):');
      console.log(wat);
    } catch (watError: any) {
      // If wasm2wat fails or is not installed, just log that we couldn't convert
      // We avoid logging the raw bytes to keep the output clean as requested.
      console.log(
        'Could not convert WASM to WAT (wasm2wat failed or not found).',
      );
      if (watError.stderr) {
        console.log('wasm2wat stderr:', watError.stderr.toString());
      }
    }
    throw e;
  }
}

/**
 * Compile, instantiate, and return full details for testing.
 * Unlike compileAndInstantiate, this returns the compiler, codegen, and modules
 * for inspecting internal state during tests.
 */
export async function compileWithDetails(
  input: string | Record<string, string>,
  options: CompileOptions = {},
): Promise<{
  exports: WebAssembly.Exports;
  codegen: CodeGenerator;
  compiler: Compiler;
  modules: Module[];
  bytes: Uint8Array;
}> {
  const path = options.path ?? '/main.zena';
  const imports = options.imports ?? {};

  let capturedExports: any = null;

  // Add default console mock if not present
  if (!imports.console) {
    const logString = (s: any, len: number) => {
      if (!capturedExports || !capturedExports.$stringGetByte) return;
      let str = '';
      for (let i = 0; i < len; i++) {
        const code = capturedExports.$stringGetByte(s, i);
        str += String.fromCharCode(code);
      }
      console.log(str);
    };

    imports.console = {
      log_i32: (v: number) => console.log(v),
      log_f32: (v: number) => console.log(v),
      log_string: logString,
      error_string: logString,
      warn_string: logString,
      info_string: logString,
      debug_string: logString,
    };
  }

  const host = createHost(input, path);
  const compiler = new Compiler(host);
  const modules = compiler.compile(path);
  const allDiagnostics = modules.flatMap((m) => m.diagnostics ?? []);
  const errors = allDiagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      `Compilation failed: ${errors.map((d) => d.message).join(', ')}`,
    );
  }

  const codegen = new CodeGenerator(
    modules,
    path,
    compiler.semanticContext,
    compiler.checkerContext,
  );
  const bytes = codegen.generate();

  const result = await WebAssembly.instantiate(bytes, imports);
  const instance = (result as any).instance || result;
  capturedExports = instance.exports;

  return {
    exports: instance.exports,
    codegen,
    compiler,
    modules,
    bytes,
  };
}

export async function compileAndRun(
  input: string | Record<string, string>,
  optionsOrEntryPoint: string | CompileOptions = 'main',
  importsArg: Record<string, any> = {},
): Promise<any> {
  let entryPoint = 'main';
  let imports = importsArg;
  let path = '/main.zena';

  if (typeof optionsOrEntryPoint === 'string') {
    entryPoint = optionsOrEntryPoint;
  } else {
    entryPoint = optionsOrEntryPoint.entryPoint ?? 'main';
    imports = optionsOrEntryPoint.imports ?? importsArg;
    path = optionsOrEntryPoint.path ?? '/main.zena';
  }

  const exports = await compileAndInstantiate(input, {
    path,
    imports,
  });

  if (exports[entryPoint]) {
    return exports[entryPoint]();
  }
  return null;
}

/**
 * Read a string from WASM using the standard byte-reading pattern.
 */
const readWasmString = (
  exports: WebAssembly.Exports,
  getter: () => unknown,
): string => {
  const stringRef = getter();
  if (stringRef === null || stringRef === undefined) {
    return '';
  }
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

  // Read root suite tests
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

  // Read nested suites (one level deep)
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
        ? readWasmString(exports, () => getNestedTestName(j))
        : '';
      const passed = getNestedTestPassed ? getNestedTestPassed(j) : false;
      const errorRef = getNestedTestError ? getNestedTestError(j) : null;
      const error =
        errorRef !== null ? readWasmString(exports, () => errorRef) : null;
      nestedTests.push({name, passed, error});
    }
    suites.push({
      name: getNestedSuiteName
        ? readWasmString(exports, () => getNestedSuiteName())
        : '',
      tests: nestedTests,
      suites: [],
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
 * Create a compiler host that can load files from disk.
 */
const createFileHost = (
  entryPath: string,
  virtualFiles: Map<string, string> = new Map(),
): CompilerHost => ({
  load: (p: string) => {
    if (virtualFiles.has(p)) {
      return virtualFiles.get(p)!;
    }
    if (p.startsWith('zena:')) {
      const name = p.substring(5);
      return readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
    }
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8');
    }
    throw new Error(`File not found: ${p}`);
  },
  resolve: (specifier: string, referrer: string) => {
    // zena:console is virtual - map to console-host for host target
    if (specifier === 'zena:console') {
      return 'zena:console-host';
    }
    if (specifier.startsWith('zena:')) {
      return specifier;
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const dir = dirname(referrer);
      return resolve(dir, specifier);
    }
    return specifier;
  },
});

export interface ZenaTestOptions {
  /** Treat the test file as stdlib (enabling intrinsics like __array_new) */
  isStdlib?: boolean;
}

/**
 * Run a Zena test file and return structured results.
 * The test file should export `tests` as a Suite.
 */
export const runZenaTestFile = async (
  filePath: string,
  options: ZenaTestOptions = {},
): Promise<ZenaSuiteResult> => {
  const absolutePath = resolve(filePath);
  const testFileName = basename(absolutePath);
  const wrapperPath = absolutePath.replace(/\.zena$/, '.__wrapper__.zena');

  // Generate wrapper that imports tests and exposes accessors
  const wrapperSource = `
import { tests } from './${testFileName}';
import { SuiteResult, TestResult } from 'zena:test';
import { Array } from 'zena:growable-array';

var _result: SuiteResult | null = null;

let result = (): SuiteResult => {
  if (_result !== null) {
    return _result;
  }
  return new SuiteResult('');
};

export let main = (): i32 => {
  _result = tests.run();
  if (_result !== null) {
    return _result.failed;
  }
  return 0;
};

export let getSuiteName = (): string => result().name;
export let getSuitePassed = (): i32 => result().passed;
export let getSuiteFailed = (): i32 => result().failed;
export let getTestCount = (): i32 => result().tests.length;
export let getNestedSuiteCount = (): i32 => result().suites.length;

export let getTestName = (index: i32): string => result().tests[index].name;
export let getTestPassed = (index: i32): boolean => result().tests[index].passed;
export let getTestError = (index: i32): string | null => result().tests[index].error;

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

  const virtualFiles = new Map<string, string>();
  virtualFiles.set(wrapperPath, wrapperSource);

  const host = createFileHost(wrapperPath, virtualFiles);
  const compilerOptions = options.isStdlib ? {stdlibPaths: [absolutePath]} : {};
  const compiler = new Compiler(host, compilerOptions);

  // compile() runs type checking on all modules
  const modules = compiler.compile(wrapperPath);
  const diagnostics = modules.flatMap((m) => m.diagnostics ?? []);
  const errors = diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.Error,
  );
  if (errors.length > 0) {
    const errorMessages = errors.map((d) => d.message).join(', ');
    throw new Error(`Compilation errors: ${errorMessages}`);
  }

  const codegen = new CodeGenerator(
    modules,
    wrapperPath,
    compiler.semanticContext,
    compiler.checkerContext,
  );
  const bytes = codegen.generate();

  // Instantiate with console mocks
  let capturedExports: WebAssembly.Exports | null = null;
  const imports = {
    console: {
      log_i32: (v: number) => console.log(v),
      log_f32: (v: number) => console.log(v),
      log_string: () => {},
      error_string: () => {},
      warn_string: () => {},
      info_string: () => {},
      debug_string: () => {},
    },
  };

  const result = await WebAssembly.instantiate(bytes, imports);
  const instance =
    result instanceof WebAssembly.Instance
      ? result
      : (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
  capturedExports = instance.exports;

  // Run main() to execute tests
  const mainFn = capturedExports.main as () => number;
  mainFn();

  // Read structured results
  const suiteResult = readSuiteResult(capturedExports);
  if (!suiteResult) {
    throw new Error('Failed to read suite results');
  }

  return suiteResult;
};

/**
 * Flatten a ZenaSuiteResult into an array of test results with full paths.
 */
export const flattenTests = (
  suite: ZenaSuiteResult,
  prefix = '',
): Array<{name: string; passed: boolean; error: string | null}> => {
  const results: Array<{name: string; passed: boolean; error: string | null}> =
    [];
  const path = prefix ? `${prefix} > ${suite.name}` : suite.name;

  for (const test of suite.tests) {
    results.push({
      name: `${path} > ${test.name}`,
      passed: test.passed,
      error: test.error,
    });
  }

  for (const nested of suite.suites) {
    results.push(...flattenTests(nested, path));
  }

  return results;
};
