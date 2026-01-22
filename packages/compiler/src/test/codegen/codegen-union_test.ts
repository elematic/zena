import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Union Types', () => {
  test('should compile and run union variable with Box<i32>', async () => {
    const source = `
      import { Box } from 'zena:box';
      export let main = (): i32 => {
        let x: Box<i32> | null = new Box(10);
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile and run union variable with null', async () => {
    const source = `
      import { Box } from 'zena:box';
      export let main = (): i32 => {
        let x: Box<i32> | null = null;
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile function union types', async () => {
    const source = `
      type F1 = (a: i32) => i32;
      type F2 = (a: i32, b: i32) => i32;
      type U = F1 | F2;

      export let main = (): i32 => {
        let f: U = (a: i32) => a * 2;
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile class union types', async () => {
    const source = `
      class A { x: i32; #new(x: i32) { this.x = x; } }
      class B { y: i32; #new(y: i32) { this.y = y; } }

      export let main = (): i32 => {
        let obj: A | B = new A(10);
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile interface union types', async () => {
    const source = `
      interface Drawable { draw(): i32; }
      interface Printable { print(): i32; }
      class Shape implements Drawable, Printable {
        draw(): i32 { return 1; }
        print(): i32 { return 2; }
      }

      export let main = (): i32 => {
        let s = new Shape();
        let d: Drawable | Printable = s;
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should compile string union with class', async () => {
    const source = `
      class Box { value: i32; #new(v: i32) { this.value = v; } }

      export let main = (): i32 => {
        let x: string | Box = 'hello';
        return 1;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
