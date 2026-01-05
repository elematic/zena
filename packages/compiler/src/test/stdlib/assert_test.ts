import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from '../codegen/utils.js';

// Most assert tests are in tests/language/stdlib/assert/assert_test.zena
// This file contains tests that can't run in zena:test due to:
// 1. Tests that verify assertions throw (nested closures cause codegen bugs)
// 2. Tests requiring class definitions (same/notSame/isNull/isNotNull)
// 3. Tests with string comparisons (cause codegen bugs in test context)

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

  suite('same (reference equality)', () => {
    test('passes for same reference', async () => {
      const source = `
        import { same } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let b = new Box(1);
          same(b, b);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('throws for different references', async () => {
      const source = `
        import { same } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let a = new Box(1);
          let b = new Box(1);
          same(a, b);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('notSame', () => {
    test('passes for different references', async () => {
      const source = `
        import { notSame } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let a = new Box(1);
          let b = new Box(1);
          notSame(a, b);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('throws for same reference', async () => {
      const source = `
        import { notSame } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let b = new Box(1);
          notSame(b, b);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('isNull', () => {
    test('passes for null', async () => {
      const source = `
        import { isNull } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let b: Box | null = null;
          isNull<Box>(b);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('throws for non-null', async () => {
      const source = `
        import { isNull } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let b: Box | null = new Box(1);
          isNull(b);
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('isNotNull', () => {
    test('passes for non-null', async () => {
      const source = `
        import { isNotNull } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let b: Box | null = new Box(1);
          isNotNull<Box>(b);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('throws for null', async () => {
      const source = `
        import { isNotNull } from 'zena:assert';
        class Box { value: i32; #new(v: i32) { this.value = v; } }
        export let run = (): i32 => {
          let b: Box | null = null;
          isNotNull(b);
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

  suite('throws', () => {
    test('passes when function throws', async () => {
      const source = `
        import { throws } from 'zena:assert';
        import { Error } from 'zena:error';
        export let run = (): i32 => {
          throws(() => {
            throw new Error('expected');
          });
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('throws when function does not throw', async () => {
      const source = `
        import { throws } from 'zena:assert';
        export let run = (): i32 => {
          throws(() => {
            let x = 1;
          });
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });

  suite('doesNotThrow', () => {
    test('passes when function does not throw', async () => {
      const source = `
        import { doesNotThrow } from 'zena:assert';
        export let run = (): i32 => {
          doesNotThrow(() => {
            let x = 1;
          });
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

    test('throws when function throws', async () => {
      const source = `
        import { doesNotThrow } from 'zena:assert';
        import { Error } from 'zena:error';
        export let run = (): i32 => {
          doesNotThrow(() => {
            throw new Error('unexpected');
          });
          return 1;
        };
      `;
      await assert.rejects(async () => {
        await compileAndRun(source, 'run');
      });
    });
  });
});
