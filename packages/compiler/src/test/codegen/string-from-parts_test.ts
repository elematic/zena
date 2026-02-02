import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('String.fromParts', () => {
  test('should compile and run String.fromParts', async () => {
    const input = `
      export let main = (): i32 => {
        let parts = #["Hello", " ", "World", "!"];
        let result = String.fromParts(parts);
        return result.length;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 12); // "Hello World!" = 12 chars
  });

  test('should compile and run String.fromParts with single element', async () => {
    const input = `
      export let main = (): i32 => {
        let parts = #["test"];
        let result = String.fromParts(parts);
        return result.length;
      };
    `;
    const result = await compileAndRun(input);
    assert.strictEqual(result, 4);
  });
});
