import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import {strictEqual} from 'node:assert';

suite('interface multi-return ref cast', () => {
  test('while-let on interface method returning inline tuple with ref type', async () => {
    // When calling next() through an interface with erased generic type params,
    // WASM returns (i32, anyref) but the destructured local expects (i32, ref null $String).
    // The codegen must insert a ref.cast to downcast anyref → concrete ref type.
    const result = await compileAndRun(`
      import { Iterator } from 'zena:iterator';

      final class SingleIter implements Iterator<String> {
        var #value: String;
        var #done: boolean;

        new(value: String) : #value = value, #done = false {}

        next(): inline (true, String) | inline (false, _) {
          if (!this.#done) {
            this.#done = true;
            return (true, this.#value);
          }
          return (false, _);
        }
      }

      let getIter = (): Iterator<String> => new SingleIter("test");

      export let main = (): i32 => {
        let iter = getIter();
        var count = 0;
        while (let (true, s) = iter.next()) {
          count = count + 1;
        }
        return count;
      };
    `);
    // SingleIter yields exactly one string, so count should be 1
    strictEqual(result, 1);
  });

  test('if-let on interface method returning inline tuple with ref type', async () => {
    const result = await compileAndRun(`
      import { Iterator } from 'zena:iterator';

      final class SingleIter2 implements Iterator<String> {
        var #value: String;
        var #done: boolean;

        new(value: String) : #value = value, #done = false {}

        next(): inline (true, String) | inline (false, _) {
          if (!this.#done) {
            this.#done = true;
            return (true, this.#value);
          }
          return (false, _);
        }
      }

      let getIter2 = (): Iterator<String> => new SingleIter2("test");

      export let main = (): i32 => {
        let iter = getIter2();
        if (let (true, s) = iter.next()) {
          return s.length;
        }
        return 0;
      };
    `);
    strictEqual(result, 4);
  });
});
