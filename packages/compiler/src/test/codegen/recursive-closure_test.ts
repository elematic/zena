import {suite, test} from 'node:test';
import {strictEqual} from 'node:assert';
import {compileAndRun} from './utils.js';

suite('recursive closures', () => {
  test('self-referencing closure at module scope', async () => {
    const result = await compileAndRun(`
      let f = (i: i32): i32 => if (i > 0) { f(i - 1) } else { 0 };
      export let main = (): i32 => f(5);
    `);
    strictEqual(result, 0);
  });

  test('self-referencing closure in block scope', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let f = (i: i32): i32 => if (i > 0) { f(i - 1) } else { 42 };
        return f(5);
      };
    `);
    strictEqual(result, 42);
  });

  test('self-referencing var closure', async () => {
    const result = await compileAndRun(`
      var f = (i: i32): i32 => if (i > 0) { f(i - 1) } else { 99 };
      export let main = (): i32 => f(3);
    `);
    strictEqual(result, 99);
  });

  test('self-referencing closure in nested function', async () => {
    const result = await compileAndRun(`
      let wrapper = (): i32 => {
        let countdown = (n: i32): i32 => if (n <= 0) { 7 } else { countdown(n - 1) };
        return countdown(10);
      };
      export let main = (): i32 => wrapper();
    `);
    strictEqual(result, 7);
  });

  test('self-recursive closure coexists with other locals', async () => {
    const result = await compileAndRun(`
      export let main = (): i32 => {
        let a = 10;
        let f = (i: i32): i32 => if (i > 0) { f(i - 1) } else { a };
        return f(3);
      };
    `);
    strictEqual(result, 10);
  });
});
