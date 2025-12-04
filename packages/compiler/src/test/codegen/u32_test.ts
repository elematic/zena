import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('Unsigned Integers (u32) - Codegen', () => {
  test('u32 addition', async () => {
    const source = `
      export let add = (a: u32, b: u32): u32 => a + b;
    `;
    const {add} = await compileAndInstantiate(source);

    // Test basic addition
    assert.strictEqual(add(5, 3), 8);
    assert.strictEqual(add(0, 0), 0);
    assert.strictEqual(add(100, 200), 300);
  });

  test('u32 subtraction', async () => {
    const source = `
      export let sub = (a: u32, b: u32): u32 => a - b;
    `;
    const {sub} = await compileAndInstantiate(source);

    assert.strictEqual(sub(10, 3), 7);
    assert.strictEqual(sub(100, 50), 50);
    // Wrapping behavior (like unsigned underflow)
    // In u32: 0 - 1 wraps to 4294967295
    const result = sub(0, 1);
    assert.strictEqual(result >>> 0, 4294967295);
  });

  test('u32 multiplication', async () => {
    const source = `
      export let mul = (a: u32, b: u32): u32 => a * b;
    `;
    const {mul} = await compileAndInstantiate(source);

    assert.strictEqual(mul(5, 3), 15);
    assert.strictEqual(mul(100, 2), 200);
  });

  test('u32 division (unsigned)', async () => {
    const source = `
      export let div = (a: u32, b: u32): u32 => a / b;
    `;
    const {div} = await compileAndInstantiate(source);

    assert.strictEqual(div(10, 3), 3); // Integer division
    assert.strictEqual(div(100, 10), 10);

    // Key test: large unsigned numbers that would be negative if signed
    // 0xFFFFFFFF (4294967295) / 2 should be 2147483647 (unsigned division)
    // If signed, -1 / 2 = 0 (signed division)
    const largeU32 = 0xffffffff >>> 0; // 4294967295
    const result = div(largeU32, 2);
    assert.strictEqual(result >>> 0, 2147483647);
  });

  test('u32 remainder (unsigned)', async () => {
    const source = `
      export let rem = (a: u32, b: u32): u32 => a % b;
    `;
    const {rem} = await compileAndInstantiate(source);

    assert.strictEqual(rem(10, 3), 1);
    assert.strictEqual(rem(100, 7), 2);

    // Test with large unsigned number
    const largeU32 = 0xffffffff >>> 0; // 4294967295
    const result = rem(largeU32, 10);
    // 4294967295 % 10 = 5
    assert.strictEqual(result >>> 0, 5);
  });

  test('u32 less than comparison (unsigned)', async () => {
    const source = `
      export let lt = (a: u32, b: u32): boolean => a < b;
    `;
    const {lt} = await compileAndInstantiate(source);

    assert.strictEqual(lt(1, 2), 1);
    assert.strictEqual(lt(2, 1), 0);
    assert.strictEqual(lt(5, 5), 0);

    // Key test: 0xFFFFFFFF (as u32) should be > 1
    // If signed, -1 < 1 would be true
    // If unsigned, 4294967295 < 1 is false
    const largeU32 = 0xffffffff >>> 0;
    assert.strictEqual(lt(largeU32, 1), 0); // false - large value is NOT less than 1
  });

  test('u32 less than or equal comparison (unsigned)', async () => {
    const source = `
      export let le = (a: u32, b: u32): boolean => a <= b;
    `;
    const {le} = await compileAndInstantiate(source);

    assert.strictEqual(le(1, 2), 1);
    assert.strictEqual(le(2, 1), 0);
    assert.strictEqual(le(5, 5), 1);

    const largeU32 = 0xffffffff >>> 0;
    assert.strictEqual(le(largeU32, 1), 0); // false
  });

  test('u32 greater than comparison (unsigned)', async () => {
    const source = `
      export let gt = (a: u32, b: u32): boolean => a > b;
    `;
    const {gt} = await compileAndInstantiate(source);

    assert.strictEqual(gt(2, 1), 1);
    assert.strictEqual(gt(1, 2), 0);
    assert.strictEqual(gt(5, 5), 0);

    // Key test: 0xFFFFFFFF (as u32) should be > 1
    const largeU32 = 0xffffffff >>> 0;
    assert.strictEqual(gt(largeU32, 1), 1); // true - large value IS greater than 1
  });

  test('u32 greater than or equal comparison (unsigned)', async () => {
    const source = `
      export let ge = (a: u32, b: u32): boolean => a >= b;
    `;
    const {ge} = await compileAndInstantiate(source);

    assert.strictEqual(ge(2, 1), 1);
    assert.strictEqual(ge(1, 2), 0);
    assert.strictEqual(ge(5, 5), 1);

    const largeU32 = 0xffffffff >>> 0;
    assert.strictEqual(ge(largeU32, 1), 1); // true
  });

  test('u32 equality comparison', async () => {
    const source = `
      export let eq = (a: u32, b: u32): boolean => a == b;
    `;
    const {eq} = await compileAndInstantiate(source);

    assert.strictEqual(eq(5, 5), 1);
    assert.strictEqual(eq(5, 3), 0);
  });

  test('u32 inequality comparison', async () => {
    const source = `
      export let ne = (a: u32, b: u32): boolean => a != b;
    `;
    const {ne} = await compileAndInstantiate(source);

    assert.strictEqual(ne(5, 5), 0);
    assert.strictEqual(ne(5, 3), 1);
  });

  test('u32 bitwise AND', async () => {
    const source = `
      export let bitwiseAnd = (a: u32, b: u32): u32 => a & b;
    `;
    const {bitwiseAnd} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseAnd(0xff, 0x0f), 0x0f);
    assert.strictEqual(bitwiseAnd(5, 3), 1);
  });

  test('u32 bitwise OR', async () => {
    const source = `
      export let bitwiseOr = (a: u32, b: u32): u32 => a | b;
    `;
    const {bitwiseOr} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseOr(0xf0, 0x0f), 0xff);
    assert.strictEqual(bitwiseOr(5, 3), 7);
  });

  test('u32 bitwise XOR', async () => {
    const source = `
      export let bitwiseXor = (a: u32, b: u32): u32 => a ^ b;
    `;
    const {bitwiseXor} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseXor(0xff, 0x0f), 0xf0);
    assert.strictEqual(bitwiseXor(5, 3), 6);
  });

  test('cast i32 to u32', async () => {
    const source = `
      export let toU32 = (x: i32): u32 => x as u32;
    `;
    const {toU32} = await compileAndInstantiate(source);

    // Casting is a no-op, just reinterprets the bits
    assert.strictEqual(toU32(42), 42);
    // -1 as u32 should be 0xFFFFFFFF
    const result = toU32(-1);
    assert.strictEqual(result >>> 0, 0xffffffff);
  });

  test('cast u32 to i32', async () => {
    const source = `
      export let toI32 = (x: u32): i32 => x as i32;
    `;
    const {toI32} = await compileAndInstantiate(source);

    assert.strictEqual(toI32(42), 42);
    // Large u32 should become negative i32
    const largeU32 = 0xffffffff >>> 0;
    assert.strictEqual(toI32(largeU32), -1);
  });

  test('i32 vs u32 division difference', async () => {
    // This test demonstrates the difference between signed and unsigned division
    const source = `
      export let divI32 = (a: i32, b: i32): i32 => a / b;
      export let divU32 = (a: u32, b: u32): u32 => a / b;
    `;
    const {divI32, divU32} = await compileAndInstantiate(source);

    // For positive numbers, both should give same result
    assert.strictEqual(divI32(10, 3), 3);
    assert.strictEqual(divU32(10, 3), 3);

    // For values that are negative when interpreted as signed:
    // 0xFFFFFFFE = -2 (signed) or 4294967294 (unsigned)
    // Divided by 2:
    // - Signed: -2 / 2 = -1
    // - Unsigned: 4294967294 / 2 = 2147483647
    const value = 0xfffffffe;
    const signedResult = divI32(value, 2);
    const unsignedResult = divU32(value, 2);

    assert.strictEqual(signedResult, -1);
    assert.strictEqual(unsignedResult >>> 0, 2147483647);
  });

  test('i32 vs u32 comparison difference', async () => {
    const source = `
      export let ltI32 = (a: i32, b: i32): boolean => a < b;
      export let ltU32 = (a: u32, b: u32): boolean => a < b;
    `;
    const {ltI32, ltU32} = await compileAndInstantiate(source);

    // For positive numbers, both should give same result
    assert.strictEqual(ltI32(1, 2), 1);
    assert.strictEqual(ltU32(1, 2), 1);

    // For -1 (0xFFFFFFFF):
    // - Signed: -1 < 1 is true
    // - Unsigned: 4294967295 < 1 is false
    const value = -1;
    assert.strictEqual(ltI32(value, 1), 1); // true
    assert.strictEqual(ltU32(value, 1), 0); // false
  });
});
