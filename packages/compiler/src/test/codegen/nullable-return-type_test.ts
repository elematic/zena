import {test, suite} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('nullable return type', () => {
  test('function returning record with nullable field', async () => {
    const source = `
      export type Foo = {
        name: string,
        value: string | null
      };

      export let makeFoo = (): Foo => {
        return { name: "test", value: null };
      };

      export let test = (): i32 => {
        let foo = makeFoo();
        if (foo.value == null) {
          return 1;
        }
        return 0;
      };
    `;

    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 1); // value should be null
  });

  test('function returning record with non-null nullable field', async () => {
    const source = `
      export type Foo = {
        name: string,
        value: string | null
      };

      export let makeFoo = (): Foo => {
        return { name: "test", value: "hello" };
      };

      export let test = (): i32 => {
        let foo = makeFoo();
        if (foo.value == null) {
          return 0;
        }
        return 1;
      };
    `;

    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 1); // value should not be null
  });
});
