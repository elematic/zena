import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import * as assert from 'node:assert';

suite('Codegen: Match Guard', () => {
  test('should compile and run match guard', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
      }

      export let testGuard = (x: i32): i32 => {
        return match (x) {
          case i if i > 10: 1
          case i if i < 5: -1
          case _: 0
        };
      };

      export let testGuardBinding = (p: Point): i32 => {
        return match (p) {
          case Point { x, y } if x == y: 1
          case Point { x, y } if x > y: 2
          case _: 3
        };
      };

      export let main = (): i32 => {
        if (testGuard(11) != 1) return 1;
        if (testGuard(4) != -1) return 2;
        if (testGuard(7) != 0) return 3;

        let p1 = new Point(10, 10);
        if (testGuardBinding(p1) != 1) return 4;

        let p2 = new Point(20, 10);
        if (testGuardBinding(p2) != 2) return 5;

        let p3 = new Point(5, 10);
        if (testGuardBinding(p3) != 3) return 6;

        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });
});
