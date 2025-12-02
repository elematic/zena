import {test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

test('strict equality operator', async () => {
  const source = `
    class Point {
      x: i32;
      #new(x: i32) { this.x = x; }
      
      operator ==(other: Point): boolean {
        return this.x == other.x;
      }
    }

    export let main = () => {
      let p1 = new Point(10);
      let p2 = new Point(10);
      let p3 = p1;

      // Custom equality (==)
      let e1 = p1 == p2; // true (values are equal)

      // Reference equality (===)
      let r1 = p1 === p1; // true
      let r2 = p1 === p2; // false (different objects, even though values are equal)
      let r3 = p1 === p3; // true (same object)
      
      // Not reference equality
      let r4 = p1 !== p2; // true
      let r5 = p1 !== p3; // false

      if (e1 == false) return 10;
      if (r1 == false) return 20;
      if (r2) return 30;
      if (r3 == false) return 40;
      if (r4 == false) return 50;
      if (r5) return 60;
      return 1;
    };
  `;

  const result = await compileAndRun(source, 'main');
  assert.strictEqual(result, 1);
});
