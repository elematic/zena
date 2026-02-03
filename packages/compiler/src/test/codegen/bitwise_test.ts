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

  test('bitwise XOR', async () => {
    const source = `
      export let bitwiseXor = (a: i32, b: i32) => a ^ b;
    `;
    const {bitwiseXor} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseXor(5, 3), 6); // 101 ^ 011 = 110 (6)
    assert.strictEqual(bitwiseXor(12, 10), 6); // 1100 ^ 1010 = 0110 (6)
    assert.strictEqual(bitwiseXor(0, 10), 10);
    assert.strictEqual(bitwiseXor(-1, 0), -1);
    assert.strictEqual(bitwiseXor(5, 5), 0);
  });

  test('bitwise XOR precedence', async () => {
    const source = `
      export let precedence1 = (a: i32, b: i32, c: i32) => a | b ^ c;
      export let precedence2 = (a: i32, b: i32, c: i32) => a ^ b & c;
    `;
    const {precedence1, precedence2} = await compileAndInstantiate(source);

    // a | (b ^ c)
    // 1 | 2 ^ 3 -> 1 | (2 ^ 3) -> 1 | 1 -> 1
    // (1 | 2) ^ 3 -> 3 ^ 3 -> 0
    assert.strictEqual(precedence1(1, 2, 3), 1);

    // a ^ (b & c)
    // 1 ^ 3 & 2 -> 1 ^ (3 & 2) -> 1 ^ 2 -> 3
    // (1 ^ 3) & 2 -> 2 & 2 -> 2
    assert.strictEqual(precedence2(1, 3, 2), 3);
  });

  test('bitwise XOR on booleans should fail', async () => {
    const source = `
      export let booleanXor = (a: boolean, b: boolean) => a ^ b;
    `;
    try {
      await compileAndInstantiate(source);
      assert.fail('Should have thrown type error');
    } catch (e: any) {
      assert.match(e.message, /Operator '\^' cannot be applied/);
    }
  });

  test('left shift <<', async () => {
    const source = `
      export let leftShift = (a: i32, b: i32) => a << b;
    `;
    const {leftShift} = await compileAndInstantiate(source);

    assert.strictEqual(leftShift(5, 1), 10); // 5 << 1 = 10
    assert.strictEqual(leftShift(5, 2), 20); // 5 << 2 = 20
    assert.strictEqual(leftShift(1, 3), 8); // 1 << 3 = 8
    assert.strictEqual(leftShift(7, 4), 112); // 7 << 4 = 112
  });

  test('right shift >> (signed)', async () => {
    const source = `
      export let rightShift = (a: i32, b: i32) => a >> b;
    `;
    const {rightShift} = await compileAndInstantiate(source);

    assert.strictEqual(rightShift(10, 1), 5); // 10 >> 1 = 5
    assert.strictEqual(rightShift(20, 2), 5); // 20 >> 2 = 5
    assert.strictEqual(rightShift(8, 3), 1); // 8 >> 3 = 1
    assert.strictEqual(rightShift(-8, 1), -4); // -8 >> 1 = -4 (sign extension)
  });

  test('unsigned right shift >>>', async () => {
    const source = `
      export let unsignedRightShift = (a: i32, b: i32) => a >>> b;
    `;
    const {unsignedRightShift} = await compileAndInstantiate(source);

    assert.strictEqual(unsignedRightShift(10, 1), 5); // 10 >>> 1 = 5
    assert.strictEqual(unsignedRightShift(20, 2), 5); // 20 >>> 2 = 5
    assert.strictEqual(unsignedRightShift(8, 3), 1); // 8 >>> 3 = 1
    // -8 in i32 is 0xFFFFFFF8, >>> 1 gives 0x7FFFFFFC (2147483644)
    assert.strictEqual(unsignedRightShift(-8, 1), 2147483644);
  });

  test('shift with u32 types', async () => {
    const source = `
      export let leftShiftU32 = (a: u32, b: u32) => a << b;
      export let rightShiftU32 = (a: u32, b: u32) => a >> b;
    `;
    const {leftShiftU32, rightShiftU32} = await compileAndInstantiate(source);

    assert.strictEqual(leftShiftU32(5, 2), 20);
    assert.strictEqual(rightShiftU32(20, 2), 5);
  });

  test('shift operators have correct precedence', async () => {
    const source = `
      export let shiftAddPrecedence = (a: i32, b: i32, c: i32) => a << b + c;
      export let shiftCompPrecedence = (a: i32, b: i32, c: i32) => (a << b) < c;
    `;
    const {shiftAddPrecedence, shiftCompPrecedence} =
      await compileAndInstantiate(source);

    // a << b + c should be a << (b + c)
    // 2 << 1 + 1 = 2 << 2 = 8
    assert.strictEqual(shiftAddPrecedence(2, 1, 1), 8);

    // (a << b) < c
    // (2 << 2) < 10 -> 8 < 10 -> true (1)
    assert.strictEqual(shiftCompPrecedence(2, 2, 10), 1);
    // (2 << 2) < 5 -> 8 < 5 -> false (0)
    assert.strictEqual(shiftCompPrecedence(2, 2, 5), 0);
  });
});
