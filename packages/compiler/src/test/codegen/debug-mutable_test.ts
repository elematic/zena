import assert from 'node:assert';
import {test} from 'node:test';
import {compileAndRun} from './utils.js';

test('debug mutable capture', async () => {
  const source = `
    export let test = () => {
      var x = 5;
      let f = () => {
        x = 10;
      };
      f();
      return x;
    };
  `;
  const result = await compileAndRun(source, 'test');
  console.log('Result:', result);
  assert.strictEqual(result, 10);
});
