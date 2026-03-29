import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {compileAndRun} from './utils.js';

suite('Case class hashCode', () => {
  test('hashCode returns i32', async () => {
    const result = await compileAndRun(`
      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let a = new Point(1, 2);
        return a.hashCode();
      };
    `);
    assert.equal(typeof result, 'number');
  });

  test('equal instances have same hashCode', async () => {
    const result = await compileAndRun(`
      class Point(x: i32, y: i32)

      export let main = (): boolean => {
        let a = new Point(1, 2);
        let b = new Point(1, 2);
        return a.hashCode() == b.hashCode();
      };
    `);
    assert.equal(result, 1);
  });

  test('different instances have different hashCode', async () => {
    const result = await compileAndRun(`
      class Point(x: i32, y: i32)

      export let main = (): boolean => {
        let a = new Point(1, 2);
        let b = new Point(3, 4);
        return a.hashCode() != b.hashCode();
      };
    `);
    assert.equal(result, 1);
  });

  test('hashCode with single field', async () => {
    const result = await compileAndRun(`
      class Wrapper(value: i32)

      export let main = (): i32 => {
        let w = new Wrapper(42);
        return w.hashCode();
      };
    `);
    // Single field: hashCode should be the field value itself
    assert.equal(result, 42);
  });
});
