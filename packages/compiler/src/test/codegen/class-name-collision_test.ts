import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('class name collision', () => {
  test('classes with same name from different modules work correctly', async () => {
    // This test verifies that classes are looked up by identity (checker type),
    // not by name. If we used name-based lookup, classes with the same name
    // from different modules would collide.
    //
    // Module A has class Data with method getValue() returning x * 2
    // Module B has class Data with method getValue() returning x + 100
    // If name-based lookup is used, the second Data overwrites the first,
    // causing incorrect results.

    const files = {
      '/main.zena': `
        import {testA} from '/moduleA.zena';
        import {testB} from '/moduleB.zena';
        
        export let runTestA = (): i32 => testA();
        export let runTestB = (): i32 => testB();
      `,
      '/moduleA.zena': `
        class Data {
          #value: i32;
          #new(v: i32) {
            this.#value = v;
          }
          getValue(): i32 {
            return this.#value * 2;
          }
        }
        
        export let testA = (): i32 => {
          let d = new Data(10);
          return d.getValue();
        };
      `,
      '/moduleB.zena': `
        class Data {
          #value: i32;
          #new(v: i32) {
            this.#value = v;
          }
          getValue(): i32 {
            return this.#value + 100;
          }
        }
        
        export let testB = (): i32 => {
          let d = new Data(10);
          return d.getValue();
        };
      `,
    };

    let exports;
    try {
      exports = await compileAndInstantiate(files);
    } catch (e) {
      console.error('Compilation failed:', e);
      throw e;
    }

    const runTestA = exports.runTestA as () => number;
    const runTestB = exports.runTestB as () => number;

    // Module A: 10 * 2 = 20
    assert.strictEqual(
      runTestA(),
      20,
      'Module A should use its own Data class',
    );
    // Module B: 10 + 100 = 110
    assert.strictEqual(
      runTestB(),
      110,
      'Module B should use its own Data class',
    );
  });
});
