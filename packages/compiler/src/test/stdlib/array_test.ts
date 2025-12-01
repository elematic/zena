import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';

suite('Stdlib: Array', () => {
  test('constructor and length', async () => {
    const source = `
      import { Array } from 'zena:array';
      export let run = (): i32 => {
        let arr = new Array<i32>(4);
        return arr.length;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 0);
  });

  test('push and get', async () => {
    const source = `
      import { Array } from 'zena:array';
      export let run = (): i32 => {
        let arr = new Array<i32>(4);
        arr.push(10);
        arr.push(20);
        if (arr.length != 2) return 1;
        if (arr[0] != 10) return 2;
        if (arr[1] != 20) return 3;
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });

  test('pop', async () => {
    const source = `
      import { Array } from 'zena:array';
      export let run = (): i32 => {
        let arr = new Array<i32>(4);
        arr.push(10);
        arr.push(20);
        let v1 = arr.pop();
        if (v1 != 20) return 1;
        if (arr.length != 1) return 2;
        let v2 = arr.pop();
        if (v2 != 10) return 3;
        if (arr.length != 0) return 4;
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });

  test('set', async () => {
    const source = `
      import { Array } from 'zena:array';
      export let run = (): i32 => {
        let arr = new Array<i32>(4);
        arr.push(10);
        arr[0] = 99;
        return arr[0];
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 99);
  });

  test('grow', async () => {
    const source = `
      import { Array } from 'zena:array';
      export let run = (): i32 => {
        let arr = new Array<i32>(4);
        // Default capacity is 4. Push 5 items to trigger grow.
        arr.push(1);
        arr.push(2);
        arr.push(3);
        arr.push(4);
        arr.push(5);
        
        if (arr.length != 5) return 1;
        if (arr[0] != 1) return 2;
        if (arr[4] != 5) return 3;
        return 100;
      };
    `;
    const result = await compileAndRun(source, 'run');
    assert.strictEqual(result, 100);
  });
});
