import {test, suite} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('nullable type alias', () => {
  test('nullable field in record should work with null', async () => {
    const source = `
      export let test = () => {
        let record: { name: string | null } = { name: null };
        return record.name == null;
      };
    `;

    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 1); // true = 1
  });

  test('nullable field can be assigned string', async () => {
    const source = `
      export let test = () => {
        let record: { name: string | null } = { name: "hello" };
        return record.name == null;
      };
    `;

    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 0); // false = 0
  });

  test('type alias with nullable field works', async () => {
    const source = `
      export type Foo = { value: string | null };
      
      export let test = () => {
        let foo: Foo = { value: null };
        return foo.value == null;
      };
    `;

    const result = await compileAndRun(source, 'test');
    assert.strictEqual(result, 1); // true = 1
  });
});
