import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';

// Most Array tests are in tests/language/stdlib/array/array_test.zena
// This file only contains tests that can't run in zena:test due to nested closure bugs

suite('Stdlib: Array (non-portable)', () => {
  test('map', async () => {
    // This test works here because the closure to map() is inside a top-level function,
    // not inside another closure. In zena:test, test callbacks are closures, so
    // arr.map((x) => ...) becomes a nested closure which triggers a codegen bug.
    // See: nested-closure-in-generic-method_test.ts
    const source = `
      import { Array } from 'zena:array';
      export let run = (): i32 => {
        let arr = new Array<i32>(4);
        arr.push(1);
        arr.push(2);
        arr.push(3);
        
        let mapped = arr.map<i32>((x: i32) => x * 2);
        
        if (mapped.length != 3) return 1;
        if (mapped[0] != 2) return 2;
        if (mapped[1] != 4) return 3;
        if (mapped[2] != 6) return 4;
        
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });
});
