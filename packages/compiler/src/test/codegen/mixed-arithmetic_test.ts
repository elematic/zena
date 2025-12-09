import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('Mixed Arithmetic Codegen', () => {
  test('should add i32 and f32', async () => {
    const source = `
      export let main = () => {
        return 1 + 2.5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 3.5);
  });

  test('should multiply i32 and f32', async () => {
    const source = `
      export let main = () => {
        return 2 * 2.5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 5.0);
  });

  test('should multiply f32 and i32', async () => {
    const source = `
      export let main = () => {
        return 2.5 * 2;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 5.0);
  });

  test('should compare i32 and f32', async () => {
    const source = `
      export let main = () => {
        if (1 < 2.5) {
          return 1;
        } else {
          return 0;
        }
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should handle complex expression', async () => {
    const source = `
      export let main = () => {
        return (1 + 2) * 2.5;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 7.5);
  });

  test('i32 + i64 -> i64', async () => {
    const source = `
      export let main = () => {
        let a: i32 = 1;
        let b: i64 = 2 as i64;
        return a + b;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 3n);
  });

  test('i32 + f64 -> f64', async () => {
    const source = `
      export let main = () => {
        let a: i32 = 1;
        let b: f64 = 2.5 as f64;
        return a + b;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 3.5);
  });

  test('i64 + f32 -> f64', async () => {
    const source = `
      export let main = () => {
        let a: i64 = 1 as i64;
        let b: f32 = 2.5;
        return a + b;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 3.5);
  });

  test('i64 + f64 -> f64', async () => {
    const source = `
      export let main = () => {
        let a: i64 = 1 as i64;
        let b: f64 = 2.5 as f64;
        return a + b;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 3.5);
  });

  test('f32 + f64 -> f64', async () => {
    const source = `
      export let main = () => {
        let a: f32 = 1.5;
        let b: f64 = 2.5 as f64;
        return a + b;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 4.0);
  });

  test('Division / always returns float (i32 / i32)', async () => {
    const source = `
      export let main = (): f32 => {
        return 1 / 2;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 0.5);
  });

  test('Division / always returns float (i64 / i64)', async () => {
    const source = `
      export let main = (): f64 => {
        return (1 as i64) / (2 as i64);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 0.5);
  });

  test('Division / always returns float (i32 / i64)', async () => {
    const source = `
      export let main = () => {
        return 1 / (2 as i64);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 0.5);
  });
});
