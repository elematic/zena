import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('Unsigned 64-bit Integers (u64) - Codegen', () => {
  test('u64 addition', async () => {
    const source = `
      export let add = (a: u64, b: u64): u64 => a + b;
    `;
    const {add} = await compileAndInstantiate(source);

    // Test basic addition
    assert.strictEqual(add(5n, 3n), 8n);
    assert.strictEqual(add(0n, 0n), 0n);
    assert.strictEqual(add(100n, 200n), 300n);
  });

  test('u64 subtraction', async () => {
    const source = `
      export let sub = (a: u64, b: u64): u64 => a - b;
    `;
    const {sub} = await compileAndInstantiate(source);

    assert.strictEqual(sub(10n, 3n), 7n);
    assert.strictEqual(sub(100n, 50n), 50n);
    // Wrapping behavior (like unsigned underflow)
    // In u64: 0 - 1 wraps to 18446744073709551615n (2^64 - 1)
    // However, at the JS boundary, i64 and u64 are both represented as i64,
    // so this will be returned as -1n (which has the same bit pattern)
    const result = sub(0n, 1n);
    assert.strictEqual(result, -1n);
  });

  test('u64 multiplication', async () => {
    const source = `
      export let mul = (a: u64, b: u64): u64 => a * b;
    `;
    const {mul} = await compileAndInstantiate(source);

    assert.strictEqual(mul(5n, 3n), 15n);
    assert.strictEqual(mul(100n, 2n), 200n);
  });

  test('u64 division (unsigned)', async () => {
    const source = `
      export let div = (a: u64, b: u64): f64 => a / b;
    `;
    const {div} = await compileAndInstantiate(source);

    assert.strictEqual(div(10n, 3n), 10 / 3); // Float division
    assert.strictEqual(div(100n, 10n), 10);

    // Key test: large unsigned numbers that would be negative if signed
    const largeU64 = 18446744073709551615n; // 2^64 - 1
    const result = div(largeU64, 2n);
    // Due to f64 precision, the exact value might be slightly off
    // 18446744073709551615 / 2 = 9223372036854775807.5
    assert(result > 9223372036854775000);
  });

  test('u64 remainder (unsigned)', async () => {
    const source = `
      export let rem = (a: u64, b: u64): u64 => a % b;
    `;
    const {rem} = await compileAndInstantiate(source);

    assert.strictEqual(rem(10n, 3n), 1n);
    assert.strictEqual(rem(100n, 7n), 2n);

    // Test with large unsigned number
    const largeU64 = 18446744073709551615n;
    const result = rem(largeU64, 10n);
    // 18446744073709551615 % 10 = 5
    assert.strictEqual(result, 5n);
  });

  test('u64 less than comparison (unsigned)', async () => {
    const source = `
      export let lt = (a: u64, b: u64): boolean => a < b;
    `;
    const {lt} = await compileAndInstantiate(source);

    assert.strictEqual(lt(1n, 2n), 1);
    assert.strictEqual(lt(2n, 1n), 0);
    assert.strictEqual(lt(5n, 5n), 0);

    // Key test: largest u64 value should be > 1
    const largeU64 = 18446744073709551615n;
    assert.strictEqual(lt(largeU64, 1n), 0); // false - large value is NOT less than 1
  });

  test('u64 less than or equal comparison (unsigned)', async () => {
    const source = `
      export let le = (a: u64, b: u64): boolean => a <= b;
    `;
    const {le} = await compileAndInstantiate(source);

    assert.strictEqual(le(1n, 2n), 1);
    assert.strictEqual(le(2n, 1n), 0);
    assert.strictEqual(le(5n, 5n), 1);

    const largeU64 = 18446744073709551615n;
    assert.strictEqual(le(largeU64, 1n), 0); // false
  });

  test('u64 greater than comparison (unsigned)', async () => {
    const source = `
      export let gt = (a: u64, b: u64): boolean => a > b;
    `;
    const {gt} = await compileAndInstantiate(source);

    assert.strictEqual(gt(2n, 1n), 1);
    assert.strictEqual(gt(1n, 2n), 0);
    assert.strictEqual(gt(5n, 5n), 0);

    // Key test: largest u64 value should be > 1
    const largeU64 = 18446744073709551615n;
    assert.strictEqual(gt(largeU64, 1n), 1); // true - large value IS greater than 1
  });

  test('u64 greater than or equal comparison (unsigned)', async () => {
    const source = `
      export let ge = (a: u64, b: u64): boolean => a >= b;
    `;
    const {ge} = await compileAndInstantiate(source);

    assert.strictEqual(ge(2n, 1n), 1);
    assert.strictEqual(ge(1n, 2n), 0);
    assert.strictEqual(ge(5n, 5n), 1);

    const largeU64 = 18446744073709551615n;
    assert.strictEqual(ge(largeU64, 1n), 1); // true
  });

  test('u64 equality comparison', async () => {
    const source = `
      export let eq = (a: u64, b: u64): boolean => a == b;
    `;
    const {eq} = await compileAndInstantiate(source);

    assert.strictEqual(eq(5n, 5n), 1);
    assert.strictEqual(eq(5n, 3n), 0);
  });

  test('u64 inequality comparison', async () => {
    const source = `
      export let ne = (a: u64, b: u64): boolean => a != b;
    `;
    const {ne} = await compileAndInstantiate(source);

    assert.strictEqual(ne(5n, 5n), 0);
    assert.strictEqual(ne(5n, 3n), 1);
  });

  test('u64 bitwise AND', async () => {
    const source = `
      export let bitwiseAnd = (a: u64, b: u64): u64 => a & b;
    `;
    const {bitwiseAnd} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseAnd(0xffn, 0x0fn), 0x0fn);
    assert.strictEqual(bitwiseAnd(5n, 3n), 1n);
  });

  test('u64 bitwise OR', async () => {
    const source = `
      export let bitwiseOr = (a: u64, b: u64): u64 => a | b;
    `;
    const {bitwiseOr} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseOr(0xf0n, 0x0fn), 0xffn);
    assert.strictEqual(bitwiseOr(5n, 3n), 7n);
  });

  test('u64 bitwise XOR', async () => {
    const source = `
      export let bitwiseXor = (a: u64, b: u64): u64 => a ^ b;
    `;
    const {bitwiseXor} = await compileAndInstantiate(source);

    assert.strictEqual(bitwiseXor(0xffn, 0x0fn), 0xf0n);
    assert.strictEqual(bitwiseXor(5n, 3n), 6n);
  });

  test('cast i64 to u64', async () => {
    const source = `
      export let toU64 = (x: i64): u64 => x as u64;
    `;
    const {toU64} = await compileAndInstantiate(source);

    // Casting is a no-op, just reinterprets the bits
    assert.strictEqual(toU64(42n), 42n);
    // -1 as u64 should be 18446744073709551615n (2^64 - 1)
    // However, at the JS boundary, i64 and u64 are both represented as i64,
    // so this will still be -1n (which has the same bit pattern)
    const result = toU64(-1n);
    assert.strictEqual(result, -1n);
  });

  test('cast u64 to i64', async () => {
    const source = `
      export let toI64 = (x: u64): i64 => x as i64;
    `;
    const {toI64} = await compileAndInstantiate(source);

    assert.strictEqual(toI64(42n), 42n);
    // Large u64 should become negative i64
    const largeU64 = 18446744073709551615n;
    assert.strictEqual(toI64(largeU64), -1n);
  });

  test('i64 vs u64 division difference', async () => {
    // This test demonstrates the difference between signed and unsigned division
    const source = `
      export let divI64 = (a: i64, b: i64): f64 => a / b;
      export let divU64 = (a: u64, b: u64): f64 => a / b;
    `;
    const {divI64, divU64} = await compileAndInstantiate(source);

    // For positive numbers, both should give same result
    assert.strictEqual(divI64(10n, 3n), 10 / 3);
    assert.strictEqual(divU64(10n, 3n), 10 / 3);

    // For values that are negative when interpreted as signed:
    // 0xFFFFFFFFFFFFFFFE = -2 (signed) or 18446744073709551614 (unsigned)
    // Divided by 2:
    // - Signed: -2 / 2 = -1.0
    // - Unsigned: 18446744073709551614 / 2 = 9223372036854775807.0
    const value = -2n;
    const signedResult = divI64(value, 2n);
    const unsignedResult = divU64(value, 2n);

    assert.strictEqual(signedResult, -1);
    assert(unsignedResult > 9223372036854775000);
  });

  test('i64 vs u64 comparison difference', async () => {
    const source = `
      export let ltI64 = (a: i64, b: i64): boolean => a < b;
      export let ltU64 = (a: u64, b: u64): boolean => a < b;
    `;
    const {ltI64, ltU64} = await compileAndInstantiate(source);

    // For positive numbers, both should give same result
    assert.strictEqual(ltI64(1n, 2n), 1);
    assert.strictEqual(ltU64(1n, 2n), 1);

    // For -1 (0xFFFFFFFFFFFFFFFF):
    // - Signed: -1 < 1 is true
    // - Unsigned: 18446744073709551615 < 1 is false
    const value = -1n;
    assert.strictEqual(ltI64(value, 1n), 1); // true
    assert.strictEqual(ltU64(value, 1n), 0); // false
  });
});
