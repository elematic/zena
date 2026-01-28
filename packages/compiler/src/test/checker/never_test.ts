import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('Checker: Never Type', () => {
  test('can use never as return type', () => {
    const input = `
      let fail = (): never => {
        unreachable();
      };
    `;
    const parser = new Parser(input, {path: 'zena:test', isStdlib: true});
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('never is assignable to anything', () => {
    const input = `
      let fail = (): never => {
        unreachable();
      };

      let test = () => {
        let x: i32 = fail();
        let y: string = fail();
        let z: boolean = fail();
      };
    `;
    const parser = new Parser(input, {path: 'zena:test', isStdlib: true});
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('can use never in union', () => {
    const input = `
      let test = (x: string | never) => {
        let y: string = x;
      };
    `;
    const parser = new Parser(input, {path: 'zena:test', isStdlib: true});
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('unreachable returns never', () => {
    const input = `
      let test = () => {
        let x: never = unreachable();
      };
    `;
    const parser = new Parser(input, {path: 'zena:test', isStdlib: true});
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });
});
