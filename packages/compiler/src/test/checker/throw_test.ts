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

  test('try/catch as statement with void/never', () => {
    const input = `
      class Error {}
      class AssertionError extends Error {
        #new(msg: string, name: string) {
          super();
        }
      }
      
      let fn = () => {};
      
      let test = () => {
        try {
          fn();
          throw new AssertionError('msg', 'throws');
        } catch (e) {
          // success - swallow the exception
        };
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('re-throw from catch', () => {
    const input = `
      class Error {}
      let test = () => {
        try {
          throw new Error();
        } catch (e) {
          throw e;
        };
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('throw new error from catch', () => {
    const input = `
      class Error {}
      class OtherError extends Error {}
      let test = () => {
        try {
          throw new Error();
        } catch (e) {
          throw new OtherError();
        };
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });
});
