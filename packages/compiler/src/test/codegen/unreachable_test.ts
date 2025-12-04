import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('Codegen - Unreachable', () => {
  test('unreachable() should trap', async () => {
    const input = `
      export let main = (): i32 => {
        unreachable();
      };
    `;
    // Must run in zena: module to access intrinsics
    await assert.rejects(
      async () => {
        await compileAndRun(input, {path: 'zena:test'});
      },
      (err: any) => {
        // WASM traps usually throw RuntimeError: unreachable
        return err.message.includes('unreachable');
      },
    );
  });

  test('unreachable() in control flow', async () => {
    const input = `
      export let main = (): i32 => {
        if (true) {
          unreachable();
        }
        return 1;
      };
    `;
    await assert.rejects(
      async () => {
        await compileAndRun(input, {path: 'zena:test'});
      },
      (err: any) => {
        return err.message.includes('unreachable');
      },
    );
  });
});
