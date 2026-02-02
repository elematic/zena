import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('String sliceBytes (view-based)', () => {
  test('sliceBytes returns correct length', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let s = "hello world";
        let sub = s.sliceBytes(0, 5);  // "hello"
        return sub.length;
      };
    `);
    assert.strictEqual(result, 5);
  });

  test('sliceBytes returns correct content', async () => {
    const result = await compileAndRun(`
      export let main = (): boolean => {
        let s = "hello world";
        let sub = s.sliceBytes(6, 11);  // "world"
        return sub == "world";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('sliceBytes can be chained (zero-copy)', async () => {
    const result = await compileAndRun(`
      export let main = (): boolean => {
        let s = "hello world";
        let sub = s.sliceBytes(0, 5).sliceBytes(1, 4);  // "ell"
        return sub == "ell";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('copy creates independent string', async () => {
    const result = await compileAndRun(`
      export let main = (): boolean => {
        let s = "hello world";
        let sub = s.sliceBytes(0, 5);
        let copied = sub.copy();
        return copied == "hello";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('sliceBytes().copy() replaces substring()', async () => {
    const result = await compileAndRun(`
      export let main = (): boolean => {
        let s = "hello world";
        let sub = s.sliceBytes(0, 5).copy();
        return sub == "hello";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('sliceBytes clamps out of bounds indices', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let s = "hello";
        let sub = s.sliceBytes(0, 100);  // Should clamp to "hello"
        return sub.length;
      };
    `);
    assert.strictEqual(result, 5);
  });

  test('sliceBytes with negative start clamps to 0', async () => {
    const result = await compileAndRun(`
      export let main = (): boolean => {
        let s = "hello";
        let sub = s.sliceBytes(0 - 5, 3);  // Should clamp start to 0
        return sub == "hel";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('getByteAt works on slices', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let s = "hello world";
        let sub = s.sliceBytes(6, 11);  // "world"
        return sub.getByteAt(0);   // 'w' = 119
      };
    `);
    assert.strictEqual(result, 119); // ASCII 'w'
  });

  test('concatenation works with slices', async () => {
    const result = await compileAndRun(`
      export let main = (): boolean => {
        let s = "hello world";
        let hello = s.sliceBytes(0, 5);
        let world = s.sliceBytes(6, 11);
        let result = hello + " " + world;
        return result == "hello world";
      };
    `);
    assert.strictEqual(result, 1);
  });
});
