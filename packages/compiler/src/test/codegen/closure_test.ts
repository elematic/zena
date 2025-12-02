import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('Codegen: Closures', () => {
  test('compiles and runs a simple closure', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let f = () => x + 1;
        return f();
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 11);
  });

  test('compiles and runs a closure with parameters', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let f = (y: i32) => x + y;
        return f(5);
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 15);
  });

  test('compiles and runs a closure capturing multiple variables', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let y = 20;
        let f = () => x + y;
        return f();
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 30);
  });

  test('compiles and runs nested closures', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let f = (y: i32) => {
            let g = (z: i32) => x + y + z;
            return g(5);
        };
        return f(20);
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 35);
  });
});
