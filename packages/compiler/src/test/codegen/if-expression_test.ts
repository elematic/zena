import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun, compileAndInstantiate} from './utils.js';

suite('Codegen - If Expression', () => {
  test('should evaluate simple if expression with true condition', async () => {
    const result = await compileAndRun(`
      export let main = () => {
        let x = if (true) 1 else 2;
        return x;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should evaluate simple if expression with false condition', async () => {
    const result = await compileAndRun(`
      export let main = () => {
        let x = if (false) 1 else 2;
        return x;
      };
    `);
    assert.strictEqual(result, 2);
  });

  test('should evaluate if expression with block bodies', async () => {
    const result = await compileAndRun(`
      export let main = () => {
        let x = if (true) { 10 } else { 20 };
        return x;
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should evaluate if expression with complex condition', async () => {
    const result = await compileAndRun(`
      export let main = () => {
        let a = 5;
        let x = if (a > 3) { a * 2 } else { a };
        return x;
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should evaluate nested if expressions (else if)', async () => {
    const exports = await compileAndInstantiate(`
      export let classify = (n: i32): i32 => {
        return if (n < 0) {
          0 - 1
        } else if (n == 0) {
          0
        } else {
          1
        };
      };
    `);
    assert.strictEqual(exports.classify(-5), -1);
    assert.strictEqual(exports.classify(0), 0);
    assert.strictEqual(exports.classify(5), 1);
  });

  test('should use if expression as function body', async () => {
    const exports = await compileAndInstantiate(`
      export let max = (a: i32, b: i32): i32 => if (a > b) a else b;
    `);
    assert.strictEqual(exports.max(5, 3), 5);
    assert.strictEqual(exports.max(3, 5), 5);
    assert.strictEqual(exports.max(4, 4), 4);
  });

  test('should use if expression inline', async () => {
    const result = await compileAndRun(`
      export let main = () => {
        let x = 5;
        return 10 + if (x > 0) 1 else 0;
      };
    `);
    assert.strictEqual(result, 11);
  });

  test('should support blocks with multiple statements', async () => {
    const result = await compileAndRun(`
      export let main = () => {
        let cond = true;
        let x = if (cond) {
          let a = 10;
          let b = 20;
          a + b
        } else {
          0
        };
        return x;
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('should support returning if expression directly', async () => {
    const exports = await compileAndInstantiate(`
      export let abs = (n: i32): i32 => if (n < 0) (0 - n) else n;
    `);
    assert.strictEqual(exports.abs(-5), 5);
    assert.strictEqual(exports.abs(5), 5);
    assert.strictEqual(exports.abs(0), 0);
  });

  test('should work with boolean results', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let isEven = if (4 % 2 == 0) true else false;
        return if (isEven) 1 else 0;
      };
    `);
    assert.strictEqual(result, 1);
  });
});
