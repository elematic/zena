import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';
import * as assert from 'node:assert';

suite('Optional Primitive Parameters', () => {
  test('Optional primitive parameter without default value should fail', async () => {
    const source = `
      export let foo = (x?: i32) => {};
      export let main = () => {};
    `;
    // We expect this to fail because x becomes i32 | null, which is invalid.
    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have failed');
    } catch (e: any) {
      assert.match(e.message, /Union types cannot contain primitive types/);
    }
  });

  test('Optional primitive parameter with default value should pass', async () => {
    const source = `
      export let foo = (x: i32 = 10) => {};
      export let main = () => {
        foo();
      };
    `;
    await compileAndRun(source, 'main');
  });

  test('Optional reference parameter should pass', async () => {
    const source = `
      export let foo = (x?: string) => {};
      export let main = () => {
        foo();
      };
    `;
    await compileAndRun(source, 'main');
  });
});
