import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import * as assert from 'node:assert';

const options = {
  imports: {
    Math: {
      pow: Math.pow
    }
  }
};

suite('Exponentiation Operator', () => {
  test('i32 exponentiation', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        return 2 ** 3;
      };
    `, options);
    assert.strictEqual(result, 8);
  });

  test('i32 exponentiation with variable', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 3;
        return x ** 3;
      };
    `, options);
    assert.strictEqual(result, 27);
  });

  test('i32 exponentiation zero exponent', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        return 10 ** 0;
      };
    `, options);
    assert.strictEqual(result, 1);
  });

  test('i32 exponentiation negative exponent', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        return 2 ** -1;
      };
    `, options);
    assert.strictEqual(result, 0);
  });

  test('f32 exponentiation', async () => {
    const result = await compileAndRun(`
      export let main = (): f32 => {
        return 2.0 ** 3.0;
      };
    `, options);
    assert.strictEqual(result, 8.0);
  });

  test('f32 exponentiation with Math.pow', async () => {
    const result = await compileAndRun(`
      import { pow } from 'zena:math';
      export let main = (): f32 => {
        return pow(2.0, 3.0);
      };
    `, options);
    assert.strictEqual(result, 8.0);
  });

  test('i32 exponentiation with zena:math powI32', async () => {
    const result = await compileAndRun(`
      import { powI32 } from 'zena:math';
      export let main = (): i32 => {
        return powI32(2, 3);
      };
    `, options);
    assert.strictEqual(result, 8);
  });

  test('associativity', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        return 2 ** 3 ** 2;
      };
    `, options);
    // 2 ** (3 ** 2) = 2 ** 9 = 512
    // (2 ** 3) ** 2 = 8 ** 2 = 64
    assert.strictEqual(result, 512);
  });

  test('mixed types: f32 ** i32', async () => {
    const result = await compileAndRun(`
      export let main = (): f32 => {
        return 2.0 ** 3;
      };
    `, options);
    assert.strictEqual(result, 8.0);
  });

  test('mixed types: i32 ** f32', async () => {
    const result = await compileAndRun(`
      export let main = (): f32 => {
        return 4 ** 0.5;
      };
    `, options);
    assert.strictEqual(result, 2.0);
  });

  test('mixed types: f32 ** negative i32', async () => {
    const result = await compileAndRun(`
      export let main = (): f32 => {
        return 2.0 ** -1;
      };
    `, options);
    assert.strictEqual(result, 0.5);
  });

  test('mixed types: u32 ** f32', async () => {
    const result = await compileAndRun(`
      export let main = (): f32 => {
        let x = 10 as u32;
        return x ** 2.0;
      };
    `, options);
    assert.strictEqual(result, 100.0);
  });

  test('mixed types: large u32 ** f32', async () => {
    const result = await compileAndRun(`
      export let main = (): f32 => {
        let x = 0xFFFFFFFF as u32;
        return x ** 2.0;
      };
    `, options);
    // If treated as signed (-1), result is 1.0
    // If treated as unsigned (MAX_U32), result is huge
    assert.notStrictEqual(result, 1.0);
    assert.ok(result > 1.0);
  });
});
