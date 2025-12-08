import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Record Spread', () => {
  test('should spread record properties', async () => {
    const source = `
      export let main = (): i32 => {
        let p = { x: 10, y: 20 };
        let p2 = { ...p, z: 30 };
        return p2.x + p2.y + p2.z;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 60);
  });

  test('should override properties with spread', async () => {
    const source = `
      export let main = (): i32 => {
        let p = { x: 10, y: 20 };
        let p2 = { x: 5, ...p }; // p.x overrides 5
        return p2.x;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 10);
  });

  test('should override spread properties with explicit assignment', async () => {
    const source = `
      export let main = (): i32 => {
        let p = { x: 10, y: 20 };
        let p2 = { ...p, x: 5 }; // 5 overrides p.x
        return p2.x;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 5);
  });

  test('should handle multiple spreads', async () => {
    const source = `
      export let main = (): i32 => {
        let p1 = { x: 10 };
        let p2 = { y: 20 };
        let p3 = { ...p1, ...p2, z: 30 };
        return p3.x + p3.y + p3.z;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 60);
  });

  test('should spread class instance', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) { this.x = x; this.y = y; }
      }
      export let main = (): i32 => {
        let pt = new Point(10, 20);
        let p = { ...pt, z: 30 };
        return p.x + p.y + p.z;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 60);
  });

  test('should spread class instance with overrides', async () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) { this.x = x; this.y = y; }
      }
      export let main = (): i32 => {
        let pt = new Point(10, 20);
        let p = { ...pt, x: 5 };
        return p.x + p.y;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 25);
  });
});
