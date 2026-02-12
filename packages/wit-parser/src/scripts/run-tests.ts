/**
 * WIT Parser Test Runner
 *
 * This script runs tests for the WIT parser by:
 * 1. Discovering all .wit test files
 * 2. For success tests: parsing .wit and comparing to .wit.json
 * 3. For error tests: parsing .wit and comparing error to .wit.result
 *
 * Currently runs in "discovery mode" since the parser isn't implemented yet.
 * Once the parser is ready, this will be updated to actually run the tests.
 */

import {readdir, readFile, stat} from 'node:fs/promises';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testsDir = join(__dirname, '..', 'tests');

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
  skipped?: boolean;
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
 * Run a single test case.
 *
 * TODO: Once the WIT parser is implemented, this will:
 * 1. Read the .wit file(s)
 * 2. Parse using the Zena WIT parser
 * 3. Compare output to expected
 *
 * For now, we just verify the test files exist and are readable.
 */
const runTest = async (test: TestCase): Promise<TestResult> => {
  try {
    // Verify input exists and is readable
    if (test.isDirectory) {
      const entries = await readdir(test.witPath);
      const witFiles = entries.filter((f) => f.endsWith('.wit'));
      if (witFiles.length === 0) {
        return {test, passed: false, error: 'No .wit files in directory'};
      }
      // Read all wit files to verify they're readable
      for (const witFile of witFiles) {
        await readFile(join(test.witPath, witFile), 'utf-8');
      }
    } else {
      await readFile(test.witPath, 'utf-8');
    }

    // Verify expected output exists and is readable
    await readFile(test.expectedPath, 'utf-8');

    // TODO: Actually run the parser and compare results
    // For now, mark as skipped since parser isn't implemented
    return {test, passed: true, skipped: true};
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
    const icon = result.skipped ? '⏭️ ' : result.passed ? '✓' : '✗';
    const status = result.skipped ? '(skipped - parser not implemented)' : '';
    console.log(`  ${icon} ${result.test.name} ${status}`);
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  // Error tests
  console.log('\n❌ Error Tests (parse should fail with expected message):\n');
  for (const result of errorTests) {
    const icon = result.skipped ? '⏭️ ' : result.passed ? '✓' : '✗';
    const status = result.skipped ? '(skipped - parser not implemented)' : '';
    console.log(`  ${icon} ${result.test.name} ${status}`);
    if (result.error) {
      console.log(`      Error: ${result.error}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const skipped = results.filter((r) => r.skipped).length;

  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Summary: ${results.length} tests discovered`);
  console.log(`   ✅ Success tests: ${successTests.length}`);
  console.log(`   ❌ Error tests: ${errorTests.length}`);
  if (skipped > 0) {
    console.log(`   ⏭️  Skipped: ${skipped} (parser not yet implemented)`);
  }
  if (failed > 0) {
    console.log(`   ❗ Failed: ${failed} (test file issues)`);
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

    // Exit with error if any tests failed (not skipped)
    const failures = results.filter((r) => !r.passed && !r.skipped);
    if (failures.length > 0) {
      process.exit(1);
    }
  } catch (e) {
    console.error('Test runner error:', e);
    process.exit(1);
  }
};

main();
