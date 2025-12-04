import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';
import * as assert from 'node:assert';

suite('AnyRef', () => {
  test('can use anyref as a type', async () => {
    const source = `
      export let testAnyRef = (x: anyref): anyref => {
        return x;
      };

      export let testAssign = (): void => {
        let s: string = "hello";
        let a: anyref = s; // string -> anyref
        
        let o: anyref = null; // null -> anyref
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.ok(exports['testAnyRef']);
  });

  test('can assign various reference types to anyref', async () => {
    const source = `
      class Point {
        x: i32;
        #new(x: i32) { this.x = x; }
      }

      export let testAssignments = (): void => {
        let a: anyref = "string";
        let b: anyref = new Point(1);
        let c: anyref = new Box(123);
        let d: anyref = #[1, 2, 3];
        let e: anyref = null;
      };
    `;
    await compileAndInstantiate(source);
  });

  test('can return anyref from function', async () => {
    const source = `
      export let getAny = (i: i32): anyref => {
        if (i == 0) return "string";
        if (i == 1) return new Box(10);
        return null;
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.ok(exports['getAny']);
  });
});
