import {suite, test} from 'node:test';
import {compileAndRun} from './codegen/utils.js';
import assert from 'node:assert';

suite('Modulo Operator', () => {
  test('modulo i32', async () => {
    const source = `
      export let test = () => {
        if (10 % 3 != 1) return 1;
        if (10 % 5 != 0) return 2;
        if (10 % 2 != 0) return 3;
        if (10 % 4 != 2) return 4;
        if ((0 - 10) % 3 != (0 - 1)) return 5;
        if (10 % (0 - 3) != 1) return 6;
        return 0;
      };
    `;
    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 0);
  });

  test('modulo precedence', async () => {
    // % has same precedence as * and /
    // 1 + 10 % 3 -> 1 + 1 -> 2
    const source = `
      export let precedence = () => 1 + 10 % 3;
    `;
    const result = await compileAndRun(source, 'precedence');
    assert.strictEqual(result, 2);
  });
});
