import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun, compileAndInstantiate} from './utils.js';

suite('codegen: unboxed tuples', () => {
  suite('multi-value returns', () => {
    test('function returning (i32, i32)', async () => {
      const source = `
        export let pair = (): (i32, i32) => ((1, 2));
      `;
      const exports = await compileAndInstantiate(source);
      const result = (exports.pair as () => [number, number])();
      // WASM multi-value returns come back as an array
      assert.deepStrictEqual(result, [1, 2]);
    });

    test('function returning (i32, i32, i32)', async () => {
      const source = `
        export let triple = (): (i32, i32, i32) => ((1, 2, 3));
      `;
      const exports = await compileAndInstantiate(source);
      const result = (exports.triple as () => [number, number, number])();
      assert.deepStrictEqual(result, [1, 2, 3]);
    });

    test('function returning computed values', async () => {
      const source = `
        export let compute = (a: i32, b: i32): (i32, i32) => ((a + b, a * b));
      `;
      const exports = await compileAndInstantiate(source);
      const compute = exports.compute as (
        a: number,
        b: number,
      ) => [number, number];
      assert.deepStrictEqual(compute(3, 4), [7, 12]);
    });

    test('return statement in block body', async () => {
      const source = `
        export let pair = (): (i32, i32) => {
          return (1, 2);
        };
      `;
      const exports = await compileAndInstantiate(source);
      const result = (exports.pair as () => [number, number])();
      assert.deepStrictEqual(result, [1, 2]);
    });

    test('conditional multi-value return', async () => {
      const source = `
        export let choose = (flag: boolean): (i32, i32) => {
          if (flag) {
            return (10, 20);
          } else {
            return (30, 40);
          }
        };
      `;
      const exports = await compileAndInstantiate(source);
      const choose = exports.choose as (flag: number) => [number, number];
      assert.deepStrictEqual(choose(1), [10, 20]);
      assert.deepStrictEqual(choose(0), [30, 40]);
    });
  });

  suite('destructuring', () => {
    test('basic destructuring', async () => {
      const source = `
        let pair = (): (i32, i32) => ((10, 20));
        
        export let main = (): i32 => {
          let (a, b) = pair();
          return a + b;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 30);
    });

    test('destructuring with three values', async () => {
      const source = `
        let triple = (): (i32, i32, i32) => ((1, 2, 3));
        
        export let main = (): i32 => {
          let (x, y, z) = triple();
          return x * 100 + y * 10 + z;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 123);
    });

    test('destructuring into computation', async () => {
      const source = `
        let compute = (a: i32, b: i32): (i32, i32) => ((a + b, a * b));
        
        export let main = (): i32 => {
          let (sum, prod) = compute(3, 4);
          return sum * 10 + prod;
        };
      `;
      const result = await compileAndRun(source);
      // sum = 7, prod = 12 -> 7*10 + 12 = 82
      assert.strictEqual(result, 82);
    });

    test('multiple destructurings', async () => {
      const source = `
        let pair = (x: i32): (i32, i32) => ((x, x * 2));
        
        export let main = (): i32 => {
          let (a, b) = pair(5);
          let (c, d) = pair(10);
          return a + b + c + d;
        };
      `;
      const result = await compileAndRun(source);
      // (5 + 10) + (10 + 20) = 45
      assert.strictEqual(result, 45);
    });
  });

  suite('mixed types', () => {
    test('(i32, boolean)', async () => {
      const source = `
        export let check = (n: i32): (i32, boolean) => {
          return (n * 2, n > 5);
        };
      `;
      const exports = await compileAndInstantiate(source);
      const check = exports.check as (n: number) => [number, number];
      assert.deepStrictEqual(check(3), [6, 0]);
      assert.deepStrictEqual(check(10), [20, 1]);
    });

    test('destructuring mixed types', async () => {
      const source = `
        let check = (n: i32): (i32, boolean) => ((n * 2, n > 5));
        
        export let main = (): i32 => {
          let (doubled, isLarge) = check(10);
          if (isLarge) {
            return doubled;
          } else {
            return 0;
          }
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 20);
    });

    test('(f64, f64)', async () => {
      const source = `
        export let sincos = (angle: f64): (f64, f64) => {
          return (angle * 0.5, angle * 2.0);
        };
      `;
      const exports = await compileAndInstantiate(source);
      const sincos = exports.sincos as (angle: number) => [number, number];
      const [a, b] = sincos(10.0);
      assert.strictEqual(a, 5.0);
      assert.strictEqual(b, 20.0);
    });
  });

  suite('nested calls', () => {
    test('chained tuple functions', async () => {
      const source = `
        let first = (): (i32, i32) => ((1, 2));
        let second = (): (i32, i32) => {
          let (a, b) = first();
          return (a * 10, b * 10);
        };
        
        export let main = (): i32 => {
          let (x, y) = second();
          return x + y;
        };
      `;
      const result = await compileAndRun(source);
      assert.strictEqual(result, 30);
    });
  });
});
