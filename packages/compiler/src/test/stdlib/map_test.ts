import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from '../codegen/utils.js';

suite('Stdlib: Map', () => {
  test('implements generic closure', async () => {
    const source = `
      class Box { value: i32; }
      export let run = (): i32 => {
        let f = <T>(x: T): T => x;
        let b = new Box();
        b.value = 10;
        return (f<Box>(b) as Box).value;
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 10);
  });

  test('array map function', async () => {
    const source = `
      export let map = <T, U>(arr: FixedArray<T>, f: (item: T) => U): FixedArray<U> => {
        let x = arr[0];
        let y = f(x);
        return #[y];
      };

      export let run = () => {
        let arr = #[10];
        let mapped = map(arr, (x: i32) => x * 2);
        return mapped[0];
      };
    `;
    const exports = await compileAndInstantiate(source);
    assert.strictEqual((exports.run as Function)(), 20);
  });
});
