import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

suite('TypeChecker - Readonly Assignment', () => {
  test('should reject assignment to getter-only property', () => {
    const input = `
      class Box {
        value: i32 {
          get { return 10; }
        }
      }
      let b = new Box();
      b.value = 20;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, DiagnosticCode.InvalidAssignment); 
    // Note: Currently it might report PropertyNotFound or something else, 
    // but we want InvalidAssignment or similar.
    // If it currently reports PropertyNotFound, this test will fail on the code check.
  });

  test('should reject indexed assignment without setter', () => {
    const input = `
      class List {
        operator [](index: i32): i32 {
          return 0;
        }
      }
      let l = new List();
      l[0] = 10;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].code, DiagnosticCode.InvalidAssignment);
  });
});
