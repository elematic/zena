import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Final Modifier', () => {
  test('should compile and run final class', async () => {
    const input = `
      final class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) {
          this.x = x;
          this.y = y;
        }
        
        final distanceSquared(): i32 {
          return this.x * this.x + this.y * this.y;
        }
      }

      export let main = (): i32 => {
        let p = new Point(3, 4);
        return p.distanceSquared();
      };
    `;
    const output = await compileAndRun(input, 'main');
    assert.strictEqual(output, 25);
  });

  test('should compile and run final method in non-final class', async () => {
    const input = `
      class Base {
        final getValue(): i32 {
          return 42;
        }
        
        getOther(): i32 {
          return 10;
        }
      }
      
      class Derived extends Base {
        getOther(): i32 {
          return 20;
        }
      }

      export let main = (): i32 => {
        let b = new Base();
        let d = new Derived();
        
        // Should use static dispatch for getValue
        return b.getValue() + d.getValue() + d.getOther();
      };
    `;
    // 42 + 42 + 20 = 104
    const output = await compileAndRun(input, 'main');
    assert.strictEqual(output, 104);
  });

  test('should compile and run final accessor', async () => {
    const input = `
      class Container {
        value: i32;
        #new(v: i32) {
          this.value = v;
        }
        
        final val: i32 {
          get {
            return this.value;
          }
          set(v) {
            this.value = v;
          }
        }
      }

      export let main = (): i32 => {
        let c = new Container(10);
        c.val = 20;
        return c.val;
      };
    `;
    const output = await compileAndRun(input, 'main');
    assert.strictEqual(output, 20);
  });
});
