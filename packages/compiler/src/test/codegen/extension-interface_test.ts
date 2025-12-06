import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';
import assert from 'node:assert';

suite('Extension Class Interfaces', () => {
  test('extension class implements interface', async () => {
    const source = `
      export interface Runnable {
        run(): i32;
      }

      export extension class ArrayRunnable on array<i32> implements Runnable {
        run(): i32 {
          return this.length;
        }
      }

      export let createArray = (): array<i32> => {
        let a = #[1, 2, 3];
        return a;
      };

      export let runIt = (arr: array<i32>): i32 => {
        let r: Runnable = arr;
        return r.run();
      };
    `;

    const exports = await compileAndInstantiate(source);
    const arr = exports.createArray();
    const result = exports.runIt(arr);
    assert.strictEqual(result, 3);
  });
});
