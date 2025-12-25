import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate} from './utils.js';

suite('CodeGenerator - Global Assignment', () => {
  test('should allow assigning to global variables', async () => {
    const input = `
      var globalCounter = 0;

      export let increment = (): i32 => {
        globalCounter = globalCounter + 1;
        return globalCounter;
      };

      export let getCounter = (): i32 => {
        return globalCounter;
      };
      
      export let setCounter = (val: i32): i32 => {
        globalCounter = val;
        return globalCounter;
      };
    `;

    const exports = await compileAndInstantiate(input);

    assert.strictEqual(exports.getCounter(), 0);
    assert.strictEqual(exports.increment(), 1);
    assert.strictEqual(exports.increment(), 2);
    assert.strictEqual(exports.getCounter(), 2);

    assert.strictEqual(exports.setCounter(100), 100);
    assert.strictEqual(exports.getCounter(), 100);
    assert.strictEqual(exports.increment(), 101);
  });

  test('should allow assigning to global variables in nested scopes', async () => {
    const input = `
      var globalValue = 10;

      export let updateIfTrue = (cond: boolean): i32 => {
        if (cond) {
          globalValue = 20;
        }
        return globalValue;
      };
    `;

    const exports = await compileAndInstantiate(input);

    assert.strictEqual(exports.updateIfTrue(false), 10);
    assert.strictEqual(exports.updateIfTrue(true), 20);
    // Should persist
    assert.strictEqual(exports.updateIfTrue(false), 20);
  });
});
