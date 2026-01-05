import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from '../codegen/utils.js';

// Most assert tests are in tests/language/stdlib/assert/assert_test.zena
// This file contains tests that can't run in zena:test due to:
// 1. Tests with string comparisons (cause codegen bugs in test context)
// 2. Negative tests (verifying assertions throw) that haven't been moved yet

suite('Stdlib: assert (non-portable)', () => {
  suite('equal', () => {
    test('throws for unequal i32 values', async () => {
      const source = `
        import { equal } from 'zena:assert';
        export let run = (): i32 => {
          equal(42, 43);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });

    test('passes for equal strings', async () => {
      const source = `
        import { equal } from 'zena:assert';
        export let run = (): i32 => {
          equal('hello', 'hello');
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('throws for unequal strings', async () => {
      const source = `
        import { equal } from 'zena:assert';
        export let run = (): i32 => {
          equal('hello', 'world');
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('notEqual', () => {
    test('throws for equal values', async () => {
      const source = `
        import { notEqual } from 'zena:assert';
        export let run = (): i32 => {
          notEqual(1, 1);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('isTrue / isFalse', () => {
    test('isTrue throws for false', async () => {
      const source = `
        import { isTrue } from 'zena:assert';
        export let run = (): i32 => {
          isTrue(false);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });

    test('isFalse throws for true', async () => {
      const source = `
        import { isFalse } from 'zena:assert';
        export let run = (): i32 => {
          isFalse(true);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('fail', () => {
    test('always throws', async () => {
      const source = `
        import { fail } from 'zena:assert';
        export let run = (): i32 => {
          fail();
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });

    test('throws with custom message', async () => {
      const source = `
        import { fail } from 'zena:assert';
        export let run = (): i32 => {
          fail('intentional failure');
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('greater', () => {
    test('throws when actual <= expected', async () => {
      const source = `
        import { greater } from 'zena:assert';
        export let run = (): i32 => {
          greater(5, 5);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('greaterOrEqual', () => {
    test('throws when actual < expected', async () => {
      const source = `
        import { greaterOrEqual } from 'zena:assert';
        export let run = (): i32 => {
          greaterOrEqual(3, 5);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('less', () => {
    test('throws when actual >= expected', async () => {
      const source = `
        import { less } from 'zena:assert';
        export let run = (): i32 => {
          less(5, 5);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('lessOrEqual', () => {
    test('throws when actual > expected', async () => {
      const source = `
        import { lessOrEqual } from 'zena:assert';
        export let run = (): i32 => {
          lessOrEqual(5, 3);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });
});
