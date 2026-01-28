import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function check(input: string) {
  const parser = new Parser(input);
  const ast = parser.parse();
  const checker = TypeChecker.forModule(ast);
  return checker.check();
}

suite('TypeChecker - If Expression', () => {
  test('should accept valid if expression', () => {
    const diagnostics = check(`
      let x = if (true) 1 else 2;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should detect non-boolean condition', () => {
    const diagnostics = check(`
      let x = if (42) 1 else 2;
    `);
    assert.strictEqual(diagnostics.length, 1);
    assert.ok(diagnostics[0].message.includes('boolean'));
  });

  test('should accept if expression with block bodies', () => {
    const diagnostics = check(`
      let x = if (true) { 1 } else { 2 };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should accept chained else-if expressions', () => {
    const diagnostics = check(`
      let classify = (n: i32): i32 => if (n < 0) (0 - 1) else if (n == 0) 0 else 1;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should accept if expression in variable initialization', () => {
    const diagnostics = check(`
      let max = (a: i32, b: i32): i32 => if (a > b) a else b;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should accept if expression with different compatible types', () => {
    const diagnostics = check(`
      let x = if (true) 1 else 2;
    `);
    assert.strictEqual(diagnostics.length, 0);
  });

  test('should accept if expression with blocks containing statements', () => {
    const diagnostics = check(`
      let compute = (cond: boolean): i32 => if (cond) {
        let a = 10;
        let b = 20;
        a + b
      } else {
        0
      };
    `);
    assert.strictEqual(diagnostics.length, 0);
  });
});
