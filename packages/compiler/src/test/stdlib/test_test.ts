import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from '../codegen/utils.js';

suite('Stdlib: test', () => {
  suite('test registration', () => {
    test('test() registers a test case in current suite', async () => {
      const source = `
        import { suite, test, TestContext } from 'zena:test';

        export let run = (): i32 => {
          let s = suite('my suite', (): void => {
            test('my test', (ctx: TestContext): void => {
              // empty test
            });
          });
          return s.tests.length;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('multiple tests are registered', async () => {
      const source = `
        import { suite, test, TestContext } from 'zena:test';

        export let run = (): i32 => {
          let s = suite('my suite', (): void => {
            test('test 1', (ctx: TestContext): void => {});
            test('test 2', (ctx: TestContext): void => {});
            test('test 3', (ctx: TestContext): void => {});
          });
          return s.tests.length;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 3);
    });
  });

  suite('suite registration', () => {
    test('suite() returns a Suite', async () => {
      const source = `
        import { suite, test, TestContext } from 'zena:test';
        import { equal } from 'zena:assert';

        export let run = (): i32 => {
          let s = suite('my suite', (): void => {
            test('nested test', (ctx: TestContext): void => {});
          });
          equal(s.name, 'my suite');
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('nested suites work', async () => {
      const source = `
        import { suite, test, TestContext } from 'zena:test';

        export let run = (): i32 => {
          let outer = suite('outer', (): void => {
            suite('inner', (): void => {
              test('deep test', (ctx: TestContext): void => {});
            });
          });
          return outer.suites.length;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('export let tests = suite(...) pattern works', async () => {
      const source = `
        import { suite, test, Suite, TestContext } from 'zena:test';
        import { equal } from 'zena:assert';

        export let tests = suite('Array', (): void => {
          test('push increases length', (ctx: TestContext): void => {
            // test body
          });
          test('pop returns last', (ctx: TestContext): void => {
            // test body
          });
        });

        export let run = (): i32 => {
          equal(tests.name, 'Array');
          equal(tests.tests.length, 2);
          return 1;
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
