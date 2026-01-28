import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('type alias name collision', () => {
  test('type aliases with same name from different modules work correctly', async () => {
    // This test verifies that type aliases from different modules don't collide.
    // Type aliases are resolved at compile time, so collisions would cause
    // one module to use the wrong underlying type.
    //
    // Module A has type ID = i32 and stores/returns an i32
    // Module B has type ID = i64 and stores/returns an i64
    // If name-based lookup collides, types would be wrong.

    const files = {
      '/main.zena': `
        import {testA} from '/moduleA.zena';
        import {testB} from '/moduleB.zena';
        
        export let runTestA = (): i32 => testA();
        export let runTestB = (): i64 => testB();
      `,
      '/moduleA.zena': `
        type ID = i32;
        
        let process = (id: ID): ID => {
          return id * 2;
        };
        
        export let testA = (): i32 => {
          let id: ID = 10;
          return process(id);
        };
      `,
      '/moduleB.zena': `
        type ID = i64;
        
        let process = (id: ID): ID => {
          return id + 100;
        };
        
        export let testB = (): i64 => {
          let id: ID = 10 as i64;
          return process(id);
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
    const runTestB = exports.runTestB as () => bigint;

    // Module A: 10 * 2 = 20 (i32)
    assert.strictEqual(runTestA(), 20, 'Module A should use ID = i32');
    // Module B: 10 + 100 = 110 (i64)
    assert.strictEqual(runTestB(), 110n, 'Module B should use ID = i64');
  });
});
