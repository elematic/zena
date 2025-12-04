import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('CodeGenerator - Pattern Matching', () => {
  test('should match identifier pattern (wildcard)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case _: 1
        };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should match identifier pattern (binding)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case y: y + 1
        };
      };
    `);
    assert.strictEqual(result, 11);
  });

  test('should match number literal pattern', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 10;
        return match (x) {
          case 10: 1
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('should match number literal pattern (no match)', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let x = 5;
        return match (x) {
          case 10: 1
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('should match class pattern', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }
      class B { y: i32; #new(y: i32) { this.y = y; } }

      export let main = (): i32 => {
        let obj: A | B = new A(10);
        return match (obj) {
          case A { x: v }: v
          case B { y: v }: v + 100
          case _: -1
        };
      };
    `);
    assert.strictEqual(result, 10);
  });

  test('should match class pattern (second case)', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }
      class B { y: i32; #new(y: i32) { this.y = y; } }

      export let main = (): i32 => {
        let obj: A | B = new B(20);
        return match (obj) {
          case A { x: v }: v
          case B { y: v }: v + 100
          case _: -1
        };
      };
    `);
    assert.strictEqual(result, 120);
  });

  test('should match class pattern with wildcard', async () => {
    const result = await compileAndRun(`
      class A { x: i32; #new(x: i32) { this.x = x; } }

      export let main = (): i32 => {
        let obj = new A(10);
        return match (obj) {
          case A { x: _ }: 1
          case _: 0
        };
      };
    `);
    assert.strictEqual(result, 1);
  });
});
