import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function check(input: string) {
  const parser = new Parser(input);
  const ast = parser.parse();
  const checker = TypeChecker.forProgram(ast);
  return checker.check();
}

suite('Checker: ByteArray', () => {
  test('can use ByteArray as function parameter', () => {
    const errors = check(`
      let f = (b: ByteArray) => {};
    `);
    assert.deepStrictEqual(errors, []);
  });

  test('can use ByteArray as field type', () => {
    const errors = check(`
      class Container {
        data: ByteArray;
      }
    `);
    assert.deepStrictEqual(errors, []);
  });
});
