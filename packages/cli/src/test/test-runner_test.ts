import assert from 'node:assert';
import {suite, test} from 'node:test';
import {runTests} from '../lib/test.js';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// From test/ go up to cli/ then into test-files/
const testFilesDir = join(__dirname, '..', 'test-files');

suite('Test Runner', () => {
  test('should run passing tests successfully', async () => {
    const summary = await runTests({
      patterns: [join(testFilesDir, 'passing_test.zena')],
    });

    assert.strictEqual(summary.passed, 1);
    assert.strictEqual(summary.failed, 0);
    assert.strictEqual(summary.total, 1);

    const result = summary.results[0];
    assert.strictEqual(result.passed, true);
    assert.ok(result.suiteResult, 'Should have suite result');
    assert.strictEqual(result.suiteResult.passed, 2);
    assert.strictEqual(result.suiteResult.failed, 0);
  });

  test('should report failures correctly', async () => {
    const summary = await runTests({
      patterns: [join(testFilesDir, 'failing_test.zena')],
    });

    assert.strictEqual(summary.passed, 0);
    assert.strictEqual(summary.failed, 1);
    assert.strictEqual(summary.total, 1);

    const result = summary.results[0];
    assert.strictEqual(result.passed, false);
    assert.ok(result.suiteResult, 'Should have suite result');
    assert.strictEqual(result.suiteResult.passed, 2);
    assert.strictEqual(result.suiteResult.failed, 1);

    // Find the failing test
    const failingTest = result.suiteResult.tests.find((t) => !t.passed);
    assert.ok(failingTest, 'Should have a failing test');
    assert.strictEqual(failingTest.name, 'this fails');
    assert.ok(failingTest.error, 'Should have error message');
    assert.ok(
      failingTest.error.includes('not equal'),
      `Error should mention equality: ${failingTest.error}`,
    );
  });

  test('should run multiple test files', async () => {
    const summary = await runTests({
      patterns: [
        join(testFilesDir, 'passing_test.zena'),
        join(testFilesDir, 'runner_test.zena'),
      ],
    });

    assert.strictEqual(summary.total, 2);
    assert.strictEqual(summary.passed, 2);
    assert.strictEqual(summary.failed, 0);
  });

  test('should handle mixed pass/fail across files', async () => {
    const summary = await runTests({
      patterns: [
        join(testFilesDir, 'passing_test.zena'),
        join(testFilesDir, 'failing_test.zena'),
      ],
    });

    assert.strictEqual(summary.total, 2);
    assert.strictEqual(summary.passed, 1);
    assert.strictEqual(summary.failed, 1);

    // First file should pass
    const passingResult = summary.results.find((r) =>
      r.file.includes('passing_test'),
    );
    assert.ok(passingResult, 'Should have passing_test result');
    assert.strictEqual(passingResult.passed, true);

    // Second file should fail
    const failingResult = summary.results.find((r) =>
      r.file.includes('failing_test'),
    );
    assert.ok(failingResult, 'Should have failing_test result');
    assert.strictEqual(failingResult.passed, false);
  });

  test('should include test names in results', async () => {
    const summary = await runTests({
      patterns: [join(testFilesDir, 'passing_test.zena')],
    });

    const result = summary.results[0];
    assert.ok(result.suiteResult, 'Should have suite result');
    assert.strictEqual(result.suiteResult.name, 'Passing Suite');

    const testNames = result.suiteResult.tests.map((t) => t.name);
    assert.ok(testNames.includes('math works'), 'Should have math test');
    assert.ok(testNames.includes('booleans work'), 'Should have boolean test');
  });

  test('should handle nested suites', async () => {
    const summary = await runTests({
      patterns: [join(testFilesDir, 'runner_test.zena')],
    });

    const result = summary.results[0];
    assert.ok(result.suiteResult, 'Should have suite result');
    assert.strictEqual(result.suiteResult.name, 'Runner Tests');

    // Should have nested suites
    assert.ok(
      result.suiteResult.suites.length >= 2,
      'Should have at least 2 nested suites',
    );

    const mathSuite = result.suiteResult.suites.find((s) => s.name === 'Math');
    assert.ok(mathSuite, 'Should have Math suite');
    assert.strictEqual(mathSuite.tests.length, 2);

    const boolSuite = result.suiteResult.suites.find(
      (s) => s.name === 'Boolean',
    );
    assert.ok(boolSuite, 'Should have Boolean suite');
    assert.strictEqual(boolSuite.tests.length, 2);
  });
});
