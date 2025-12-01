import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Optional Parameters and Defaults', () => {
  test('should support optional parameters with defaults in functions', async () => {
    const source = `
      export let main = (): i32 => {
        let add = (a: i32, b: i32 = 10): i32 => a + b;
        return add(5);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 15);
  });

  test('should support optional parameters with defaults in methods', async () => {
    const source = `
      class Calculator {
        add(a: i32, b: i32 = 20): i32 {
          return a + b;
        }
      }
      export let main = (): i32 => {
        let calc = new Calculator();
        return calc.add(5);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 25);
  });

  test('should support optional parameters with defaults in constructors', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        constructor(x: i32, y: i32 = 0) {
          this.x = x;
          this.y = y;
        }
      }
      export let main = (): i32 => {
        let p = new Point(10);
        return p.x + p.y;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 10);
  });

  test('should support multiple optional parameters', async () => {
    const source = `
      export let main = (): i32 => {
        let sum = (a: i32, b: i32 = 1, c: i32 = 2): i32 => a + b + c;
        return sum(10);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 13);
  });

  test('should support providing optional parameters', async () => {
    const source = `
      export let main = (): i32 => {
        let sum = (a: i32, b: i32 = 1, c: i32 = 2): i32 => a + b + c;
        return sum(10, 5, 5);
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 20);
  });

  test('should support optional parameters in Array constructor', async () => {
    const source = `
      import { Array } from 'zena:array';
      export let main = (): i32 => {
        let arr = new Array<i32>(); // Should use default capacity
        arr.push(1);
        return arr.length;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
