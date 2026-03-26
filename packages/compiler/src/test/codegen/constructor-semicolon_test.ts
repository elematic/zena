import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('constructor semicolon body', () => {
  test('constructor with semicolon and initializer list', async () => {
    const result = await compileAndRun(`
      class Point {
        let x: i32;
        let y: i32;
        new(x: i32, y: i32) : x = x, y = y;
      }

      export let main = () => {
        let p = new Point(3, 7);
        return p.x + p.y;
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('constructor with semicolon and no initializer list', async () => {
    const result = await compileAndRun(`
      class Counter {
        var count: i32 = 0;
        new();
      }

      export let main = () => {
        let c = new Counter();
        return c.count;
      };
    `);
    assert.strictEqual(result, 0);
  });
});
