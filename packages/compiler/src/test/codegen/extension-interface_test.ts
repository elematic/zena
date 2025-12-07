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

  test('extension class implements generic interface', async () => {
    const source = `
      export interface HasFirst<T> {
        getFirst(): T;
      }

      export extension class ArrayWithFirst on array<i32> implements HasFirst<i32> {
        getFirst(): i32 {
          return this[0];
        }
      }

      export let createArray = (): ArrayWithFirst => {
        let a = #[2, 3, 5];
        return a;
      };

      export let runIt = (arr: ArrayWithFirst): i32 => {
        // Get first from the interface
        let f: HasFirst<i32> = arr;
        var v = f.getFirst();

        // Get first from the extension class        
        v = v * arr.getFirst();

        return v;
      };
    `;

    const exports = await compileAndInstantiate(source);
    const arr = exports.createArray();
    const result = exports.runIt(arr);
    assert.strictEqual(result, 4);
  });

  test('generic extension class implements generic interface', async () => {
    const source = `
      export interface HasFirst<T> {
        getFirst(): T;
      }

      export extension class ArrayWithFirst<T> on array<T> implements HasFirst<T> {
        getFirst(): T {
          return this[0];
        }
      }

      export let createArray = (): ArrayWithFirst<i32> => {
        let a = #[2, 3, 5];
        return a;
      };

      export let runIt = (arr: ArrayWithFirst<i32>): i32 => {
        // Get first from the interface
        let f: HasFirst<i32> = arr;
        var v = f.getFirst();

        // Get first from the extension class        
        v = v * arr.getFirst();

        return v;
      };
    `;

    const exports = await compileAndInstantiate(source);
    const arr = exports.createArray();
    const result = exports.runIt(arr);
    assert.strictEqual(result, 4);
  });
});
