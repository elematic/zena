import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('function name collision', () => {
  test('functions with same name from different modules work correctly', async () => {
    // This test verifies that functions are looked up by identity (declaration),
    // not by name. If we used name-based lookup, functions with the same name
    // from different modules would collide.
    //
    // Module A has function compute() returning x * 2
    // Module B has function compute() returning x + 100
    // If name-based lookup is used, the second compute() overwrites the first,
    // causing incorrect results.

    const files = {
      '/main.zena': `
        import {testA} from '/moduleA.zena';
        import {testB} from '/moduleB.zena';
        
        export let runTestA = (): i32 => testA();
        export let runTestB = (): i32 => testB();
      `,
      '/moduleA.zena': `
        let compute = (x: i32): i32 => {
          return x * 2;
        };
        
        export let testA = (): i32 => {
          return compute(10);
        };
      `,
      '/moduleB.zena': `
        let compute = (x: i32): i32 => {
          return x + 100;
        };
        
        export let testB = (): i32 => {
          return compute(10);
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
      'Module A should use its own compute() function',
    );
    // Module B: 10 + 100 = 110
    assert.strictEqual(
      runTestB(),
      110,
      'Module B should use its own compute() function',
    );
  });
});
