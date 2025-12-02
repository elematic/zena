import { suite, test } from 'node:test';
import { compileAndRun } from './utils.js';
import * as assert from 'node:assert';

suite('Hash Intrinsic', () => {
  test('hash(i32)', async () => {
    const result = await compileAndRun(`
      @intrinsic('hash')
      declare function hash<T>(val: T): i32;

      export let main = (): i32 => {
        return hash(123);
      };
    `);
    assert.strictEqual(result, 123);
  });

  test('hash(boolean)', async () => {
    const result = await compileAndRun(`
      @intrinsic('hash')
      declare function hash<T>(val: T): i32;

      export let main = (): i32 => {
        return hash(true);
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('hash(string)', async () => {
    const result = await compileAndRun(`
      @intrinsic('hash')
      declare function hash<T>(val: T): i32;

      export let main = (): i32 => {
        return hash("hello");
      };
    `);
    assert.notStrictEqual(result, 0);
  });

  test('hash(class with hashCode)', async () => {
    const result = await compileAndRun(`
      @intrinsic('hash')
      declare function hash<T>(val: T): i32;

      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) { this.x = x; this.y = y; }
        
        hashCode(): i32 {
          return this.x + this.y;
        }
      }

      export let main = (): i32 => {
        var p = new Point(10, 20);
        return hash(p);
      };
    `);
    assert.strictEqual(result, 30);
  });

  test('hash(class without hashCode)', async () => {
    const result = await compileAndRun(`
      @intrinsic('hash')
      declare function hash<T>(val: T): i32;

      class Empty {}

      export let main = (): i32 => {
        var e = new Empty();
        return hash(e);
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('hash(generic)', async () => {
    const result = await compileAndRun(`
      @intrinsic('hash')
      declare function hash<T>(val: T): i32;

      let hashWrapper = <T>(val: T): i32 => {
        return hash(val);
      };

      export let main = (): i32 => {
        return hashWrapper(42);
      };
    `);
    assert.strictEqual(result, 42);
  });
});
