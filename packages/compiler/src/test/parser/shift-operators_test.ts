import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {
  NodeType,
  type BinaryExpression,
  type VariableDeclaration,
} from '../../lib/ast.js';

suite('Shift Operators Parser', () => {
  test('parses left shift', () => {
    const parser = new Parser('let x = a << b;', {
      path: 'test.zena',
      isStdlib: false,
    });
    const module = parser.parse();

    const varDecl = module.body[0] as VariableDeclaration;
    assert.strictEqual(varDecl.type, NodeType.VariableDeclaration);
    const init = varDecl.init as BinaryExpression;
    assert.strictEqual(init.type, NodeType.BinaryExpression);
    assert.strictEqual(init.operator, '<<');
  });

  test('parses right shift', () => {
    const parser = new Parser('let x = a >> b;', {
      path: 'test.zena',
      isStdlib: false,
    });
    const module = parser.parse();

    const varDecl = module.body[0] as VariableDeclaration;
    assert.strictEqual(varDecl.type, NodeType.VariableDeclaration);
    const init = varDecl.init as BinaryExpression;
    assert.strictEqual(init.type, NodeType.BinaryExpression);
    assert.strictEqual(init.operator, '>>');
  });

  test('parses unsigned right shift', () => {
    const parser = new Parser('let x = a >>> b;', {
      path: 'test.zena',
      isStdlib: false,
    });
    const module = parser.parse();

    const varDecl = module.body[0] as VariableDeclaration;
    assert.strictEqual(varDecl.type, NodeType.VariableDeclaration);
    const init = varDecl.init as BinaryExpression;
    assert.strictEqual(init.type, NodeType.BinaryExpression);
    assert.strictEqual(init.operator, '>>>');
  });

  test('shift has higher precedence than comparison', () => {
    // a < b << c should parse as a < (b << c)
    const parser = new Parser('let x = a < b << c;', {
      path: 'test.zena',
      isStdlib: false,
    });
    const module = parser.parse();

    const varDecl = module.body[0] as VariableDeclaration;
    const comparison = varDecl.init as BinaryExpression;
    assert.strictEqual(comparison.operator, '<');

    const shift = comparison.right as BinaryExpression;
    assert.strictEqual(shift.operator, '<<');
  });

  test('shift has lower precedence than additive', () => {
    // a << b + c should parse as a << (b + c)
    const parser = new Parser('let x = a << b + c;', {
      path: 'test.zena',
      isStdlib: false,
    });
    const module = parser.parse();

    const varDecl = module.body[0] as VariableDeclaration;
    const shift = varDecl.init as BinaryExpression;
    assert.strictEqual(shift.operator, '<<');

    const add = shift.right as BinaryExpression;
    assert.strictEqual(add.operator, '+');
  });

  test('left associativity of shift operators', () => {
    // a << b << c should parse as (a << b) << c
    const parser = new Parser('let x = a << b << c;', {
      path: 'test.zena',
      isStdlib: false,
    });
    const module = parser.parse();

    const varDecl = module.body[0] as VariableDeclaration;
    const outerShift = varDecl.init as BinaryExpression;
    assert.strictEqual(outerShift.operator, '<<');

    const innerShift = outerShift.left as BinaryExpression;
    assert.strictEqual(innerShift.operator, '<<');
  });
});
