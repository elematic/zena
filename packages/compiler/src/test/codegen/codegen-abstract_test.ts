import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Abstract Classes', () => {
  test('should compile and run concrete subclass', async () => {
    const input = `
      abstract class Shape {
        abstract area(): i32;
        getType(): i32 {
          return 1;
        }
      }
      class Square extends Shape {
        side: i32;
        #new(side: i32) {
          this.side = side;
        }
        area(): i32 {
          return this.side * this.side;
        }
      }
      export let main = (): i32 => {
        let s: Shape = new Square(5);
        return s.area() + s.getType();
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 26);
  });

  test('should support multi-level inheritance with abstract classes', async () => {
    const input = `
      abstract class A {
        abstract foo(): i32;
      }
      abstract class B extends A {
        abstract bar(): i32;
        foo(): i32 { return 10; }
      }
      class C extends B {
        bar(): i32 { return 20; }
      }
      export let main = (): i32 => {
        let c: B = new C();
        return c.foo() + c.bar();
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 30);
  });
});
