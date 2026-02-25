import {test, suite} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('div overload resolution', () => {
  test('div with cast literal - i32', async () => {
    const source = `
import { div } from 'zena:math';

export let main = (): i32 => {
  var value: i32 = 123;
  value = div(value, 10 as i32);
  return value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 12);
  });

  test('div with cast literal - i64', async () => {
    const source = `
import { div } from 'zena:math';

export let main = (): i64 => {
  var value: i64 = 123 as i64;
  value = div(value, 10 as i64);
  return value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 12n);
  });

  test('div with cast literal - u32', async () => {
    const source = `
import { div } from 'zena:math';

export let main = (): u32 => {
  var value: u32 = 123 as u32;
  value = div(value, 10 as u32);
  return value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 12);
  });

  test('div with cast literal - u64', async () => {
    const source = `
import { div } from 'zena:math';

export let main = (): u64 => {
  var value: u64 = 123 as u64;
  value = div(value, 10 as u64);
  return value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 12n);
  });

  test('div without cast - should infer i32', async () => {
    const source = `
import { div } from 'zena:math';

export let main = (): i32 => {
  var value: i32 = 123;
  value = div(value, 10);
  return value;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 12);
  });
});
