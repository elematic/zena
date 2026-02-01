import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';
import assert from 'node:assert';

suite('Math Intrinsics', () => {
  test('div i32', async () => {
    const source = `
      import {div} from 'zena:math';
      export let intDiv = (a: i32, b: i32) => div(a, b);
    `;
    const {intDiv} = await compileAndInstantiate(source);

    assert.strictEqual(intDiv(10, 3), 3);
    assert.strictEqual(intDiv(-10, 3), -3);
    assert.strictEqual(intDiv(10, -3), -3);
    assert.strictEqual(intDiv(-10, -3), 3);
    assert.strictEqual(intDiv(0, 5), 0);
    assert.strictEqual(intDiv(7, 2), 3);
  });

  test('div i64', async () => {
    const source = `
      import {div} from 'zena:math';
      export let intDiv64 = (a: i64, b: i64) => div(a, b);
    `;
    const {intDiv64} = await compileAndInstantiate(source);

    assert.strictEqual(intDiv64(10n, 3n), 3n);
    assert.strictEqual(intDiv64(-10n, 3n), -3n);
    assert.strictEqual(intDiv64(10n, -3n), -3n);
    assert.strictEqual(intDiv64(-10n, -3n), 3n);
  });

  test('div u32', async () => {
    const source = `
      import {div} from 'zena:math';
      export let uintDiv = (a: u32, b: u32) => div(a, b);
    `;
    const {uintDiv} = await compileAndInstantiate(source);

    assert.strictEqual(uintDiv(10, 3), 3);
    assert.strictEqual(uintDiv(0xFFFFFFFE, 2), 0x7FFFFFFF); // Large unsigned value
  });

  test('div u64', async () => {
    const source = `
      import {div} from 'zena:math';
      export let uintDiv64 = (a: u64, b: u64) => div(a, b);
    `;
    const {uintDiv64} = await compileAndInstantiate(source);

    assert.strictEqual(uintDiv64(10n, 3n), 3n);
    assert.strictEqual(uintDiv64(0xFFFFFFFFFFFFFFFFn, 2n), 0x7FFFFFFFFFFFFFFFn); // Large unsigned value
  });

  test('i32_trunc_s f32 to i32', async () => {
    const source = `
      import {i32_trunc_s} from 'zena:math';
      export let truncF32ToI32 = (x: f32) => i32_trunc_s(x);
    `;
    const {truncF32ToI32} = await compileAndInstantiate(source);

    assert.strictEqual(truncF32ToI32(1.9), 1);
    assert.strictEqual(truncF32ToI32(-1.9), -1);
    assert.strictEqual(truncF32ToI32(0.0), 0);
    assert.strictEqual(truncF32ToI32(42.7), 42);
    assert.strictEqual(truncF32ToI32(-42.7), -42);
  });

  test('i32_trunc_s f64 to i32', async () => {
    const source = `
      import {i32_trunc_s} from 'zena:math';
      export let truncF64ToI32 = (x: f64) => i32_trunc_s(x);
    `;
    const {truncF64ToI32} = await compileAndInstantiate(source);

    assert.strictEqual(truncF64ToI32(1.9), 1);
    assert.strictEqual(truncF64ToI32(-1.9), -1);
    assert.strictEqual(truncF64ToI32(0.0), 0);
    assert.strictEqual(truncF64ToI32(42.7), 42);
    assert.strictEqual(truncF64ToI32(-42.7), -42);
  });

  test('i64_trunc_s f32 to i64', async () => {
    const source = `
      import {i64_trunc_s} from 'zena:math';
      export let truncF32ToI64 = (x: f32) => i64_trunc_s(x);
    `;
    const {truncF32ToI64} = await compileAndInstantiate(source);

    assert.strictEqual(truncF32ToI64(1.9), 1n);
    assert.strictEqual(truncF32ToI64(-1.9), -1n);
    assert.strictEqual(truncF32ToI64(0.0), 0n);
    assert.strictEqual(truncF32ToI64(42.7), 42n);
    assert.strictEqual(truncF32ToI64(-42.7), -42n);
  });

  test('i64_trunc_s f64 to i64', async () => {
    const source = `
      import {i64_trunc_s} from 'zena:math';
      export let truncF64ToI64 = (x: f64) => i64_trunc_s(x);
    `;
    const {truncF64ToI64} = await compileAndInstantiate(source);

    assert.strictEqual(truncF64ToI64(1.9), 1n);
    assert.strictEqual(truncF64ToI64(-1.9), -1n);
    assert.strictEqual(truncF64ToI64(0.0), 0n);
    assert.strictEqual(truncF64ToI64(42.7), 42n);
    assert.strictEqual(truncF64ToI64(-42.7), -42n);
  });

  test('i32_trunc_u f32 to i32', async () => {
    const source = `
      import {i32_trunc_u} from 'zena:math';
      export let truncUF32ToI32 = (x: f32) => i32_trunc_u(x);
    `;
    const {truncUF32ToI32} = await compileAndInstantiate(source);

    assert.strictEqual(truncUF32ToI32(1.9), 1);
    assert.strictEqual(truncUF32ToI32(0.0), 0);
    assert.strictEqual(truncUF32ToI32(100.5), 100);
    assert.strictEqual(truncUF32ToI32(42.7), 42);
  });

  test('i32_trunc_u f64 to i32', async () => {
    const source = `
      import {i32_trunc_u} from 'zena:math';
      export let truncUF64ToI32 = (x: f64) => i32_trunc_u(x);
    `;
    const {truncUF64ToI32} = await compileAndInstantiate(source);

    assert.strictEqual(truncUF64ToI32(1.9), 1);
    assert.strictEqual(truncUF64ToI32(0.0), 0);
    assert.strictEqual(truncUF64ToI32(100.5), 100);
    assert.strictEqual(truncUF64ToI32(42.7), 42);
  });

  test('i64_trunc_u f32 to i64', async () => {
    const source = `
      import {i64_trunc_u} from 'zena:math';
      export let truncUF32ToI64 = (x: f32) => i64_trunc_u(x);
    `;
    const {truncUF32ToI64} = await compileAndInstantiate(source);

    assert.strictEqual(truncUF32ToI64(1.9), 1n);
    assert.strictEqual(truncUF32ToI64(0.0), 0n);
    assert.strictEqual(truncUF32ToI64(100.5), 100n);
    assert.strictEqual(truncUF32ToI64(42.7), 42n);
  });

  test('i64_trunc_u f64 to i64', async () => {
    const source = `
      import {i64_trunc_u} from 'zena:math';
      export let truncUF64ToI64 = (x: f64) => i64_trunc_u(x);
    `;
    const {truncUF64ToI64} = await compileAndInstantiate(source);

    assert.strictEqual(truncUF64ToI64(1.9), 1n);
    assert.strictEqual(truncUF64ToI64(0.0), 0n);
    assert.strictEqual(truncUF64ToI64(100.5), 100n);
    assert.strictEqual(truncUF64ToI64(42.7), 42n);
  });

  test('saturating conversion at boundary', async () => {
    const source = `
      import {i32_trunc_s} from 'zena:math';
      export let truncLarge = (x: f64) => i32_trunc_s(x);
    `;
    const {truncLarge} = await compileAndInstantiate(source);

    // Test that very large values saturate to i32 max
    // i32 max is 2147483647
    assert.strictEqual(truncLarge(3e9), 2147483647);
    assert.strictEqual(truncLarge(-3e9), -2147483648);
  });
});
