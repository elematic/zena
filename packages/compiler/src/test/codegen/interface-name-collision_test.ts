import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('interface name collision', () => {
  test('interfaces with same name from different modules work correctly', async () => {
    // This test verifies that interfaces are looked up by identity (checker type),
    // not by name. If we used name-based lookup, interfaces with the same name
    // from different modules would collide.
    //
    // Module A has interface Handler with method handle() returning x * 2
    // Module B has interface Handler with method process() returning x + 100
    // If name-based lookup is used, the second Handler overwrites the first,
    // causing the wrong vtable to be used.

    const files = {
      '/main.zena': `
        import {testA} from '/moduleA.zena';
        import {testB} from '/moduleB.zena';
        
        export let runTestA = (): i32 => testA();
        export let runTestB = (): i32 => testB();
      `,
      '/moduleA.zena': `
        interface Handler {
          handle(x: i32): i32;
        }
        
        class MyHandler implements Handler {
          handle(x: i32): i32 {
            return x * 2;
          }
        }
        
        let useHandler = (h: Handler): i32 => {
          return h.handle(10);
        };
        
        export let testA = (): i32 => {
          let h = new MyHandler();
          return useHandler(h);
        };
      `,
      '/moduleB.zena': `
        interface Handler {
          process(x: i32): i32;
        }
        
        class MyHandler implements Handler {
          process(x: i32): i32 {
            return x + 100;
          }
        }
        
        let useHandler = (h: Handler): i32 => {
          return h.process(10);
        };
        
        export let testB = (): i32 => {
          let h = new MyHandler();
          return useHandler(h);
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
      'Module A should use its own Handler interface',
    );
    // Module B: 10 + 100 = 110
    assert.strictEqual(
      runTestB(),
      110,
      'Module B should use its own Handler interface',
    );
  });
});
