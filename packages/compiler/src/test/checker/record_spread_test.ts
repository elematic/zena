import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {DiagnosticCode} from '../../lib/diagnostics.js';

function check(source: string) {
  const parser = new Parser(source);
  const program = parser.parse();
  const checker = TypeChecker.forProgram(program);
  return checker.check();
}

suite('Checker: Record Spread', () => {
  test('should reject spreading primitives', () => {
    const source = `
      let x = 10;
      let p = { ...x };
    `;
    const diagnostics = check(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
    assert.match(
      diagnostics[0].message,
      /Spread argument must be a record or class/,
    );
  });

  test('should reject spreading arrays', () => {
    const source = `
      let x = #[1, 2];
      let p = { ...x };
    `;
    const diagnostics = check(source);
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].code, DiagnosticCode.TypeMismatch);
  });

  test('should allow spreading strings (as empty record)', () => {
    const source = `
      let x = "hello";
      let p = { ...x };
    `;
    const diagnostics = check(source);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should allow spreading classes', () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        #new(x: i32, y: i32) { this.x = x; this.y = y; }
      }
      let pt = new Point(10, 20);
      let p = { ...pt };
    `;
    const diagnostics = check(source);
    assert.strictEqual(diagnostics.length, 0);
  });
});
