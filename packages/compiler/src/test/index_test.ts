import assert from 'node:assert';
import {suite, test} from 'node:test';

suite('Rhea Compiler', () => {
  test('should pass a basic test', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
