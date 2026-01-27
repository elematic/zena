import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('CodeGenerator - Accessors', () => {
  test('should compile and run accessor getter and setter', async () => {
    const input = `
      class Box {
        #value: i32;
        
        #new(v: i32) {
          this.#value = v;
        }

        value: i32 {
          get {
            return this.#value;
          }
          set(v) {
            this.#value = v;
          }
        }
      }
      export let main = (): i32 => {
        let b = new Box(10);
        b.value = 20;
        return b.value;
      };
    `;
    const exports = await compileAndInstantiate(input);
    assert.strictEqual(exports.main(), 20);
  });

  test('should compile and run accessor with only getter', async () => {
    const input = `
      class Box {
        #value: i32;
        
        #new(v: i32) {
          this.#value = v;
        }

        value: i32 {
          get {
            return this.#value * 2;
          }
        }
      }
      export let main = (): i32 => {
        let b = new Box(10);
        return b.value;
      };
    `;
    const exports = await compileAndInstantiate(input);
    assert.strictEqual(exports.main(), 20);
  });
});
