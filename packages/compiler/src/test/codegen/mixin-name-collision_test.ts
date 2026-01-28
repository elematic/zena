import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndInstantiate} from './utils.js';

suite('mixin name collision', () => {
  test('mixins with same name from different modules work correctly', async () => {
    // This test verifies that mixins are looked up by identity (checker type),
    // not by name. If we used name-based lookup, mixins with the same name
    // from different modules would collide.
    //
    // Module A has mixin Modifier that adds 10 to a value
    // Module B has mixin Modifier that multiplies a value by 3
    // If name-based lookup is used, the second Modifier overwrites the first,
    // causing incorrect results.

    const files = {
      '/main.zena': `
        import {testA} from '/moduleA.zena';
        import {testB} from '/moduleB.zena';
        
        export let runTestA = (): i32 => testA();
        export let runTestB = (): i32 => testB();
      `,
      '/moduleA.zena': `
        class Base {
          value: i32 = 5;
        }
        
        mixin Modifier on Base {
          modify(): i32 {
            return this.value + 10;
          }
        }
        
        class Modified extends Base with Modifier {}
        
        export let testA = (): i32 => {
          let m = new Modified();
          return m.modify();
        };
      `,
      '/moduleB.zena': `
        class Base {
          value: i32 = 5;
        }
        
        mixin Modifier on Base {
          modify(): i32 {
            return this.value * 3;
          }
        }
        
        class Modified extends Base with Modifier {}
        
        export let testB = (): i32 => {
          let m = new Modified();
          return m.modify();
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

    // Module A: 5 + 10 = 15
    assert.strictEqual(
      runTestA(),
      15,
      'Module A should use its own Modifier mixin',
    );
    // Module B: 5 * 3 = 15
    assert.strictEqual(
      runTestB(),
      15,
      'Module B should use its own Modifier mixin',
    );
  });
});
