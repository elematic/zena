import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Extension Classes', () => {
  test('should call extension method on primitive', async () => {
    const input = `
      extension class Meters on i32 {
        toCentimeters(): i32 {
          return this * 100;
        }
      }
      export let main = (): i32 => {
        let m = 5 as Meters;
        return m.toCentimeters();
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 500);
  });

  test('should access static field on extension class', async () => {
    const input = `
      extension class Meters on i32 {
        static FACTOR: i32 = 100;
        
        toCentimeters(): i32 {
            return this * Meters.FACTOR;
        }
      }
      export let main = (): i32 => {
        let m = 2 as Meters;
        return m.toCentimeters();
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 200);
  });

  test('should support getters in extension class', async () => {
    const input = `
      extension class Meters on i32 {
        cm: i32 {
            get { return this * 100; }
        }
      }
      export let main = (): i32 => {
        let m = 3 as Meters;
        return m.cm;
      };
    `;
    const result = await compileAndRun(input, 'main');
    assert.strictEqual(result, 300);
  });
});
