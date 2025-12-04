import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Logical Patterns', () => {
  test('should match logical OR pattern (literals)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 2;
        return match (x) {
          case 1 | 2: 100
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 100);
  });

  test('should match logical OR pattern (literals - second branch)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 1;
        return match (x) {
          case 1 | 2: 100
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 100);
  });

  test('should match logical OR pattern (literals - no match)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 3;
        return match (x) {
          case 1 | 2: 100
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('should match logical OR pattern with binding', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case (10 as y) | (20 as y): y
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should match logical AND pattern', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }

      export let main = (): i32 => {
        let obj = new A(10);
        return match (obj) {
          case A { x: _ } & A { x: 10 }: 1
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should match logical AND pattern with bindings', async () => {
    const result = await compileAndRun(`
      class Point { x: i32; y: i32; #new(x: i32, y: i32) { this.x = x; this.y = y; } }

      export let main = (): i32 => {
        let p = new Point(10, 20);
        return match (p) {
          case Point { x } & Point { y }: x + y
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 30);
  });
});
