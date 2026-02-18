import {suite, test} from 'node:test';
import {strictEqual} from 'node:assert';
import {compileAndRun} from './utils.js';

suite('function passed as argument', () => {
  test('module-level function passed to another function', async () => {
    const result = await compileAndRun(`
      let callFactory = (factory: () => i32): i32 => factory();
      let myFactory = (): i32 => 42;
      export let main = (): i32 => callFactory(myFactory);
    `);
    strictEqual(result, 42);
  });

  test('module-level function passed across modules', async () => {
    const result = await compileAndRun(
      {
        '/module-a.zena': `
          export let callFactory = (factory: () => i32): i32 => factory();
        `,
        '/main.zena': `
          import { callFactory } from '/module-a.zena';
          let myFactory = (): i32 => 99;
          export let main = (): i32 => callFactory(myFactory);
        `,
      },
      {entryPoint: 'main', path: '/main.zena'},
    );
    strictEqual(result, 99);
  });

  test('module-level function with parameter passed as argument', async () => {
    const result = await compileAndRun(`
      let applyToTen = (f: (x: i32) => i32): i32 => f(10);
      let double = (x: i32): i32 => x * 2;
      export let main = (): i32 => applyToTen(double);
    `);
    strictEqual(result, 20);
  });

  test('exported function passed as argument', async () => {
    const result = await compileAndRun(`
      let callFactory = (factory: () => i32): i32 => factory();
      export let myFactory = (): i32 => 123;
      export let main = (): i32 => callFactory(myFactory);
    `);
    strictEqual(result, 123);
  });
});
