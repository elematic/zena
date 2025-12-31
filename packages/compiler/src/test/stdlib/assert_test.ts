import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from '../codegen/utils.js';

suite('Stdlib: assert', () => {
  suite('equal', () => {
    test('passes for equal i32 values', async () => {
      const source = `
        import { equal } from 'zena:assert';
        export let run = (): i32 => {
          equal(42, 42);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

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

    test('passes for equal booleans', async () => {
      const source = `
        import { equal } from 'zena:assert';
        export let run = (): i32 => {
          equal(true, true);
          equal(false, false);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });
  });

  suite('notEqual', () => {
    test('passes for unequal values', async () => {
      const source = `
        import { notEqual } from 'zena:assert';
        export let run = (): i32 => {
          notEqual(1, 2);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

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
    test('isTrue passes for true', async () => {
      const source = `
        import { isTrue } from 'zena:assert';
        export let run = (): i32 => {
          isTrue(true);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
    });

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

    test('isFalse passes for false', async () => {
      const source = `
        import { isFalse } from 'zena:assert';
        export let run = (): i32 => {
          isFalse(false);
          return 1;
        };
      `;
      const result = await compileAndRun(source, 'run');
      assert.strictEqual(result, 1);
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
});
