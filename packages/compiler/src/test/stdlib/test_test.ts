import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from '../codegen/utils.js';

suite('Stdlib: test', () => {
  suite('test registration', () => {
    test('test() registers a test case', async () => {
      // Registration must happen inside exported function due to
      // top-level statement limitation in Zena
      const source = `
        import { test, getRootSuite, TestContext } from 'zena:test';

        export let run = (): i32 => {
          test('my test', (ctx: TestContext): void => {
            // empty test
          });
          let root = getRootSuite();
          return root.tests.length;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('multiple tests are registered', async () => {
      const source = `
        import { test, getRootSuite, TestContext } from 'zena:test';

        export let run = (): i32 => {
          test('test 1', (ctx: TestContext): void => {});
          test('test 2', (ctx: TestContext): void => {});
          test('test 3', (ctx: TestContext): void => {});
          let root = getRootSuite();
          return root.tests.length;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 3);
    });
  });

  suite('suite registration', () => {
    test('suite() creates a nested suite', async () => {
      const source = `
        import { suite, test, getRootSuite, TestContext } from 'zena:test';

        export let run = (): i32 => {
          suite('my suite', (): void => {
            test('nested test', (ctx: TestContext): void => {});
          });
          let root = getRootSuite();
          return root.suites.length;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('nested suites work', async () => {
      const source = `
        import { suite, test, getRootSuite, TestContext } from 'zena:test';

        export let run = (): i32 => {
          suite('outer', (): void => {
            suite('inner', (): void => {
              test('deep test', (ctx: TestContext): void => {});
            });
          });
          let root = getRootSuite();
          let outer = root.suites[0];
          return outer.suites.length;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });
  });

  suite('TestResult', () => {
    test('can create passing result', async () => {
      const source = `
        import { TestResult } from 'zena:test';
        import { isTrue, isNull, equal } from 'zena:assert';

        export let run = (): i32 => {
          let result = new TestResult('my test', true, null);
          equal(result.name, 'my test');
          isTrue(result.passed);
          isNull<Error>(result.error);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('can create failing result', async () => {
      const source = `
        import { TestResult } from 'zena:test';
        import { isFalse, isNotNull, equal } from 'zena:assert';
        import { Error } from 'zena:error';

        export let run = (): i32 => {
          let err = new Error('test failed');
          let result = new TestResult('my test', false, err);
          equal(result.name, 'my test');
          isFalse(result.passed);
          isNotNull<Error>(result.error);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });
  });
});
