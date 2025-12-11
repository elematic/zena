
import { suite, test } from 'node:test';
import { compileAndRun } from './utils.js';

suite('Repro', () => {
  test('Map with Point', async () => {
    const source = `
      @intrinsic('eq')
      declare function equals<T>(a: T, b: T): boolean;

      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) { this.x = x; this.y = y; }
        operator ==(other: Point): boolean {
          return this.x == other.x && this.y == other.y;
        }
      }

      class Container<T> {
        item: T;
        #new(item: T) { this.item = item; }
        check(other: T): boolean {
          return equals(this.item, other);
        }
      }

      export let main = (): void => {
        let p1 = new Point(1, 2);
        let c = new Container<Point>(p1);
        c.check(p1);
      };
    `;
    await compileAndRun(source, 'main');
  });
});
