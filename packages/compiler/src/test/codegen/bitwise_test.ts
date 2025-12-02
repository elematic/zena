import {suite, test} from 'node:test';
import {compile} from '../../lib/index.js';
import {compileAndInstantiate} from './utils.js';
import assert from 'node:assert';

suite('Bitwise Operators', () => {
  test('bitwise AND', async () => {
    const source = `
      export let bitwiseAnd = (a: i32, b: i32) => a & b;
    `;
    const {bitwiseAnd} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseAnd(5, 3), 1); // 101 & 011 = 001
    assert.strictEqual(bitwiseAnd(12, 10), 8); // 1100 & 1010 = 1000
    assert.strictEqual(bitwiseAnd(0, 10), 0);
    assert.strictEqual(bitwiseAnd(-1, 5), 5);
  });

  test('bitwise AND precedence', async () => {
    // & has lower precedence than ==
    // a & b == c  ->  a & (b == c)
    // But wait, in C: == (7) > & (8).
    // So a & b == c parses as a & (b == c).
    // If b == c is true (1) or false (0).
    // So 5 & 3 == 3 -> 5 & (3 == 3) -> 5 & 1 -> 1.
    // If precedence was (5 & 3) == 3 -> 1 == 3 -> 0.

    const source = `
      export let precedence = (a: i32, b: i32, c: i32) => a & b == c;
    `;
    // Note: This relies on implicit conversion of boolean to i32?
    // Zena does NOT support implicit coercion.
    // So `b == c` returns boolean.
    // `a & boolean` should be a TYPE ERROR.

    // So my precedence test should fail to compile if I implemented it correctly!

    try {
      compile(source);
      assert.fail('Should have thrown type error');
    } catch (e: any) {
      assert.match(e.message, /Type mismatch/);
    }
  });

  test('bitwise AND precedence with parens', async () => {
    const source = `
      export let precedence = (a: i32, b: i32, c: i32) => (a & b) == c;
    `;
    const {precedence} = await compileAndInstantiate(source);

    assert.strictEqual(precedence(5, 3, 1), 1); // (5 & 3) == 1 -> 1 == 1 -> true (1)
    assert.strictEqual(precedence(5, 3, 0), 0); // (5 & 3) == 0 -> 1 == 0 -> false (0)
  });
});
