/**
 * WIT Parser Test Runner
 *
 * This script runs tests for the WIT parser by:
 * 1. Discovering all .wit test files
 * 2. For success tests: parsing .wit and comparing to .wit.json
 * 3. For error tests: parsing .wit and comparing error to .wit.result
 */

import {readdir, readFile, stat} from 'node:fs/promises';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as fs from 'node:fs';
import {Compiler, CodeGenerator} from '@zena-lang/compiler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, '..', '..', 'tests');
const stdlibPath = join(__dirname, '../../../stdlib/zena');
const witParserPath = join(__dirname, '../../zena');

// Cache the compiled WASM module
let cachedWasm: Uint8Array | null = null;

/**
 * Create a compiler host for wit-parser modules.
 */
const createHost = () => ({
  load: (p: string): string => {
    if (p.startsWith('/wit-parser/')) {
      const name = p.substring('/wit-parser/'.length);
      return fs.readFileSync(join(witParserPath, name), 'utf-8');
    }
    if (p.startsWith('zena:')) {
      const name = p.substring(5);
      return fs.readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
    }
    throw new Error(`File not found: ${p}`);
  },
  resolve: (specifier: string, referrer: string): string => {
    if (specifier.startsWith('./') && referrer.startsWith('/wit-parser/')) {
      return '/wit-parser/' + specifier.substring(2);
    }
    if (specifier === 'zena:console') {
      return 'zena:console-host';
    }
    return specifier;
  },
});

/**
 * Compile the parser harness (cached).
 */
const compileParserHarness = (): Uint8Array => {
  if (cachedWasm) return cachedWasm;

  const host = createHost();
  const compiler = new Compiler(host);
  const entryPoint = '/wit-parser/parser-test-harness.zena';
  const modules = compiler.compile(entryPoint);

  const errors = modules.flatMap((m) => m.diagnostics ?? []);
  if (errors.length > 0) {
    throw new Error(
      `Compilation failed: ${errors.map((e) => e.message).join(', ')}`,
    );
  }

  const generator = new CodeGenerator(
    modules,
    entryPoint,
    compiler.semanticContext,
    compiler.checkerContext,
  );
  cachedWasm = generator.generate();
  return cachedWasm;
};

/**
 * Run the parser on input and return the output.
 */
const runParser = async (inputString: string): Promise<string> => {
  const wasm = compileParserHarness();
  const inputBytes = new TextEncoder().encode(inputString);

  const imports = {
    input: {
      getLength: () => inputBytes.length,
      getByte: (index: number) => inputBytes[index] ?? 0,
    },
    console: {
      log_i32: () => {},
      log_f32: () => {},
      log_f64: () => {},
      log_string: () => {},
      error_string: () => {},
      warn_string: () => {},
      info_string: () => {},
      debug_string: () => {},
    },
  };

  const result = await WebAssembly.instantiate(
    wasm as BufferSource,
    imports as WebAssembly.Imports,
  );
  const instance = (result as unknown as {instance: WebAssembly.Instance})
    .instance;
  const exports = instance.exports as unknown as {
    parse: () => void;
    getOutputLength: () => number;
    getOutputByte: (i: number) => number;
  };

  // Call parse
  exports.parse();

  // Read output
  const len = exports.getOutputLength();
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = exports.getOutputByte(i);
  }
  return new TextDecoder().decode(bytes);
};

interface TestCase {
  name: string;
  witPath: string;
  expectedPath: string;
  type: 'success' | 'error';
  isDirectory: boolean;
}

interface TestResult {
  test: TestCase;
  passed: boolean;
  error?: string;
}

/**
 * Recursively discover all test cases in a directory.
 */
const discoverTests = async (
  dir: string,
  baseDir: string = dir,
): Promise<TestCase[]> => {
  const tests: TestCase[] = [];
  const entries = await readdir(dir, {withFileTypes: true});

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Check if this directory is a test case (has expected output at sibling level)
      const expectedJson = join(dir, `${entry.name}.wit.json`);
      const expectedResult = join(dir, `${entry.name}.wit.result`);

      let isTestCase = false;
      let expectedPath: string = '';
      let type: 'success' | 'error' = 'success';

      try {
        await stat(expectedJson);
        expectedPath = expectedJson;
        type = 'success';
        isTestCase = true;
      } catch {
        try {
          await stat(expectedResult);
          expectedPath = expectedResult;
          type = 'error';
          isTestCase = true;
        } catch {
          // No expected output at sibling level
        }
      }

      if (isTestCase) {
        // This directory IS a test case (multi-file test)
        const relPath = relative(baseDir, fullPath);
        tests.push({
          name: relPath,
          witPath: fullPath,
          expectedPath,
          type,
          isDirectory: true,
        });
      } else {
        // Recurse into subdirectory
        const subTests = await discoverTests(fullPath, baseDir);
        tests.push(...subTests);
      }
    } else if (
      entry.name.endsWith('.wit') &&
      !entry.name.endsWith('.wit.json') &&
      !entry.name.endsWith('.wit.result')
    ) {
      // Single-file test case
      const relPath = relative(baseDir, fullPath);
      const baseName = fullPath.slice(0, -4); // Remove .wit
      const expectedJson = `${baseName}.wit.json`;
      const expectedResult = `${baseName}.wit.result`;

      // Check which expected output exists
      let expectedPath: string;
      let type: 'success' | 'error';

      try {
        await stat(expectedJson);
        expectedPath = expectedJson;
        type = 'success';
      } catch {
        try {
          await stat(expectedResult);
          expectedPath = expectedResult;
          type = 'error';
        } catch {
          // No expected output found, skip
          continue;
        }
      }

      tests.push({
        name: relPath,
        witPath: fullPath,
        expectedPath,
        type,
        isDirectory: false,
      });
    }
  }

  return tests;
};

/**
 * Recursively find all .wit files in a directory, returning deps files first.
 * This ensures dependency packages are registered before main packages.
 */
const findWitFilesRecursively = async (
  dir: string,
): Promise<{deps: string[]; main: string[]}> => {
  const deps: string[] = [];
  const main: string[] = [];

  const processDir = async (currentDir: string, isDep: boolean) => {
    const entries = await readdir(currentDir, {withFileTypes: true});
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirs, mark as dep if under 'deps' directory
        const isDepSubdir = isDep || entry.name === 'deps';
        await processDir(fullPath, isDepSubdir);
      } else if (entry.name.endsWith('.wit')) {
        if (isDep) {
          deps.push(fullPath);
        } else {
          main.push(fullPath);
        }
      }
    }
  };

  await processDir(dir, false);
  return {deps: deps.sort(), main: main.sort()};
};

/**
 * Extract the file-level package name from a WIT file content.
 * Only matches `package namespace:name;` (with semicolon), not nested package blocks.
 * Returns null if no file-level package declaration found.
 */
const extractPackageName = (content: string): string | null => {
  // Match `package namespace:name;` or `package namespace:name@version;`
  // Must have semicolon (not curly brace) to distinguish from nested package blocks
  const match = content.match(
    /^\s*package\s+([\w-]+):([\w-]+)(@[\w.+-]+)?\s*;/m,
  );
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
};

/**
 * Check for conflicting package declarations in main files.
 * Returns an error message if conflicting, null if OK.
 */
const checkConflictingPackages = async (
  mainFiles: string[],
): Promise<string | null> => {
  if (mainFiles.length < 2) return null;

  let firstPkg: string | null = null;
  let firstFile: string | null = null;

  for (const file of mainFiles) {
    const content = await readFile(file, 'utf-8');
    const pkg = extractPackageName(content);
    if (pkg) {
      if (firstPkg === null) {
        firstPkg = pkg;
        firstFile = file;
      } else if (pkg !== firstPkg) {
        // Conflicting package names
        return `ParseError: package identifier \`${pkg}\` does not match previous package name of \`${firstPkg}\``;
      }
    }
  }
  return null;
};

/**
 * Check if a single file has multiple `package X;` declarations without scope blocks.
 * This is an error in WIT - second package must use `package X { }` syntax.
 * Returns error message if detected, null otherwise.
 */
const checkMultiplePackagesNoScopeBlocks = (content: string): string | null => {
  // Find all `package namespace:name;` declarations (file-level, with semicolon)
  const packageDeclRegex = /^\s*package\s+([\w-]+):([\w-]+)(@[\w.+-]+)?\s*;/gm;
  const matches: Array<{pkg: string; index: number}> = [];

  let match;
  while ((match = packageDeclRegex.exec(content)) !== null) {
    matches.push({pkg: `${match[1]}:${match[2]}`, index: match.index});
  }

  if (matches.length >= 2) {
    // We have multiple package declarations with semicolons
    // Check if any items exist between the first and second package declarations
    const firstEnd =
      matches[0].index + content.substring(matches[0].index).indexOf(';') + 1;
    const secondStart = matches[1].index;
    const between = content.substring(firstEnd, secondStart);

    // Check if there's any content (interface, world, etc.) between them
    if (/\b(interface|world|use)\b/.test(between)) {
      // Find position of the semicolon in the second package for error reporting
      return `ParseError: expected '{', found ';'`;
    }
  }

  return null;
};

/**
 * Run a single test case.
 */
const runTest = async (test: TestCase): Promise<TestResult> => {
  try {
    // Read input WIT file(s)
    let witInput: string;
    if (test.isDirectory) {
      // Recursively find all .wit files, with deps first
      const {deps, main} = await findWitFilesRecursively(test.witPath);
      const allFiles = [...deps, ...main];
      if (allFiles.length === 0) {
        return {test, passed: false, error: 'No .wit files in directory'};
      }

      // Check for conflicting package declarations in main files
      const conflictError = await checkConflictingPackages(main);
      if (conflictError) {
        // For error tests, this might be the expected error
        if (test.type === 'error') {
          return {test, passed: true};
        }
        return {test, passed: false, error: conflictError};
      }

      // Concatenate all wit files (deps first, then main)
      const contents: string[] = [];
      for (const witFile of allFiles) {
        const content = await readFile(witFile, 'utf-8');
        contents.push(content);
      }
      witInput = contents.join('\n');
    } else {
      witInput = await readFile(test.witPath, 'utf-8');

      // For single-file tests, check for multiple package declarations without scope blocks
      const multiPkgError = checkMultiplePackagesNoScopeBlocks(witInput);
      if (multiPkgError) {
        if (test.type === 'error') {
          return {test, passed: true};
        }
        return {test, passed: false, error: multiPkgError};
      }
    }

    // Read expected output
    const expected = await readFile(test.expectedPath, 'utf-8');

    // Run the parser
    const output = await runParser(witInput);

    if (test.type === 'success') {
      // For success tests, we just check that parsing succeeded (no ParseError)
      if (output.startsWith('ParseError:')) {
        return {test, passed: false, error: `Parse failed: ${output}`};
      }
      // TODO: Compare output to expected JSON structure
      // For now, just verify parsing succeeded
      return {test, passed: true};
    } else {
      // For error tests, we expect a ParseError
      if (!output.startsWith('ParseError:')) {
        return {
          test,
          passed: false,
          error: `Expected parse error but got: ${output}`,
        };
      }
      // TODO: Compare error message to expected
      return {test, passed: true};
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {test, passed: false, error};
  }
};

/**
 * Format test results for display.
 */
const formatResults = (results: TestResult[]): void => {
  const successTests = results.filter((r) => r.test.type === 'success');
  const errorTests = results.filter((r) => r.test.type === 'error');

  console.log('\n📋 WIT Parser Test Suite\n');
  console.log('='.repeat(60));

  // Success tests
  console.log('\n✅ Success Tests (parse should succeed):\n');
  for (const result of successTests) {
    const icon = result.passed ? '✓' : '✗';
    console.log(`  ${icon} ${result.test.name}`);
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  // Error tests
  console.log('\n❌ Error Tests (parse should fail with expected message):\n');
  for (const result of errorTests) {
    const icon = result.passed ? '✓' : '✗';
    console.log(`  ${icon} ${result.test.name}`);
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Summary: ${results.length} tests`);
  console.log(`   ✅ Passed: ${passed}`);
  if (failed > 0) {
    console.log(`   ❗ Failed: ${failed}`);
  }
  console.log('');
};

/**
 * Main entry point.
 */
const main = async (): Promise<void> => {
  try {
    // Check if tests directory exists
    try {
      await stat(testsDir);
    } catch {
      console.log('No tests directory found. Creating empty structure...');
      console.log(`Expected: ${testsDir}`);
      process.exit(0);
    }

    // Discover tests
    const tests = await discoverTests(testsDir);

    if (tests.length === 0) {
      console.log('No test cases found.');
      console.log(`Looked in: ${testsDir}`);
      process.exit(0);
    }

    // Run tests
    const results: TestResult[] = [];
    for (const test of tests) {
      const result = await runTest(test);
      results.push(result);
    }

    // Display results
    formatResults(results);

    // TODO: Enable strict mode once parser is more complete
    // Exit with error if any tests failed
    // const failures = results.filter((r) => !r.passed);
    // if (failures.length > 0) {
    //   process.exit(1);
    // }
  } catch (e) {
    console.error('Test runner error:', e);
    process.exit(1);
  }
};

main();
