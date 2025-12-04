import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('Checker: Throw Expression', () => {
  test('throw returns never', () => {
    const input = `
      class Error {}
      let test = () => {
        let x: never = throw new Error();
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('throw requires Error', () => {
    const input = `
      class Error {}
      let test = () => {
        throw 1;
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Thrown value must be an instance of Error/,
    );
  });

  test('throw in expression', () => {
    const input = `
      class Error {}
      let test = () => {
        let x: i32 = 1 + throw new Error();
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });
});
