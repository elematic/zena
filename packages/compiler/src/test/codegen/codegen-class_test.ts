import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Classes', () => {
  test('should compile and run class instantiation and field access', async () => {
    const input = `
      class Point {
        x: i32;
        y: i32;
        new(x: i32, y: i32) : x = x, y = y {}
        getX(): i32 {
          return this.x;
        }
      }
      export let main = (): i32 => {
        let p = new Point(10, 20);
        return p.getX();
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 10);
  });

  test('should compile and run field assignment', async () => {
    const input = `
      class Point {
        x: i32 = 0;
        new() {}
      }
      export let main = (): i32 => {
        let p = new Point();
        p.x = 42;
        return p.x;
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 42);
  });
});
