import {test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

test('block scope variables are not accessible outside the block', () => {
  const source = `
    let f = () => {
      {
        var y = 10;
      }
      return y;
    };
  `;
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = new TypeChecker(ast);
  const errors = checker.check();

  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /Variable 'y' not found/);
});

test('nested block variables are not accessible in outer block', () => {
  const source = `
    let f = () => {
      {
        {
          var innerVar = 100;
        }
        return innerVar;
      }
    };
  `;
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = new TypeChecker(ast);
  const errors = checker.check();

  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /Variable 'innerVar' not found/);
});

test('block scoping allows shadowing without error', () => {
  const source = `
    let f = () => {
      var x = 1;
      {
        var x = 2;
      }
      return x;
    };
  `;
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = new TypeChecker(ast);
  const errors = checker.check();

  // No error - shadowing in inner block is allowed
  assert.strictEqual(errors.length, 0);
});
