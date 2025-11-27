import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Interface Properties', () => {
  test('should access interface property implemented as field', async () => {
    const input = `
      interface Point {
        x: i32;
        y: i32;
      }
      
      class PointImpl implements Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }
      
      export let main = (): i32 => {
        let p = new PointImpl(10, 20);
        let i: Point = p;
        return i.x + i.y;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 30);
  });

  test('should access interface property implemented as getter', async () => {
    const input = `
      interface Point {
        x: i32;
      }
      
      class PointImpl implements Point {
        x: i32 {
          get { return 42; }
        }
      }
      
      export let main = (): i32 => {
        let p = new PointImpl();
        let i: Point = p;
        return i.x;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 42);
  });
});
