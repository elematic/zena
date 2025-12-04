import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';
import assert from 'node:assert';

suite('Codegen: Unary Expressions', () => {
  test('should handle logical NOT (!)', async () => {
    const source = `
      export let main = () => {
        let t = true;
        let f = false;
        
        if (!t) {
          return 1; // Should not happen
        }
        
        if (!f) {
          if (!!t) {
            return 0; // Success
          }
        }
        
        return 2;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });

  test('should handle numeric negation (-) for i32', async () => {
    const source = `
      export let main = () => {
        let x = 10;
        let y = -x;
        let z = -(-5);
        
        if (y != -10) return 1;
        if (z != 5) return 2;
        
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });

  test('should handle numeric negation (-) for f32', async () => {
    const source = `
      export let main = () => {
        let x = 10.5;
        let y = -x;
        let z = -(-5.5);
        
        if (y != -10.5) return 1;
        if (z != 5.5) return 2;
        
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'main');
    assert.strictEqual(result, 0);
  });
});
