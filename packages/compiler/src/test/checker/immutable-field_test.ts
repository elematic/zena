import {suite, test} from 'node:test';
import * as assert from 'node:assert/strict';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(source: string) {
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = TypeChecker.forModule(ast);
  const errors = checker.check();
  return {diagnostics: errors};
}

suite('Immutable Fields', () => {
  test('cannot assign to immutable field', () => {
    const {diagnostics} = check(`
      class Point {
        x: i32;
        y: i32;
        new(x: i32, y: i32): x = x, y = y {}
      }
      let p = new Point(1, 2);
      p.x = 10;
    `);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, DiagnosticCode.InvalidAssignment);
    assert.match(
      diagnostics[0].message,
      /Cannot assign to immutable field 'x'/,
    );
  });

  test('can assign to mutable field', () => {
    const {diagnostics} = check(`
      class Point {
        var x: i32;
        var y: i32;
        new(x: i32, y: i32): x = x, y = y {}
      }
      let p = new Point(1, 2);
      p.x = 10;
    `);

    assert.equal(diagnostics.length, 0);
  });
});
