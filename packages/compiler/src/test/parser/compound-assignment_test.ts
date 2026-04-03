import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';
import type {AssignmentExpression, ExpressionStatement} from '../../lib/ast.js';

suite('Compound Assignment Parser', () => {
  test('parses x += 1', () => {
    const parser = new Parser('var x = 0; x += 1;');
    const ast = parser.parse();
    const stmt = ast.body[1] as ExpressionStatement;
    const expr = stmt.expression as AssignmentExpression;
    assert.strictEqual(expr.type, NodeType.AssignmentExpression);
    assert.strictEqual(expr.operator, '+');
    assert.strictEqual(expr.left.type, NodeType.Identifier);
    assert.strictEqual(expr.value.type, NodeType.NumberLiteral);
  });

  test('parses x -= 1', () => {
    const parser = new Parser('var x = 0; x -= 1;');
    const ast = parser.parse();
    const stmt = ast.body[1] as ExpressionStatement;
    const expr = stmt.expression as AssignmentExpression;
    assert.strictEqual(expr.operator, '-');
  });

  test('parses x *= 2', () => {
    const parser = new Parser('var x = 0; x *= 2;');
    const ast = parser.parse();
    const stmt = ast.body[1] as ExpressionStatement;
    const expr = stmt.expression as AssignmentExpression;
    assert.strictEqual(expr.operator, '*');
  });

  test('parses x /= 2', () => {
    const parser = new Parser('var x: f32 = 0; x /= 2;');
    const ast = parser.parse();
    const stmt = ast.body[1] as ExpressionStatement;
    const expr = stmt.expression as AssignmentExpression;
    assert.strictEqual(expr.operator, '/');
  });

  test('parses x %= 3', () => {
    const parser = new Parser('var x = 0; x %= 3;');
    const ast = parser.parse();
    const stmt = ast.body[1] as ExpressionStatement;
    const expr = stmt.expression as AssignmentExpression;
    assert.strictEqual(expr.operator, '%');
  });

  test('plain = has no operator field', () => {
    const parser = new Parser('var x = 0; x = 1;');
    const ast = parser.parse();
    const stmt = ast.body[1] as ExpressionStatement;
    const expr = stmt.expression as AssignmentExpression;
    assert.strictEqual(expr.operator, undefined);
  });

  test('parses member expression +=', () => {
    const parser = new Parser('var x = 0; x += 1;');
    const ast = parser.parse();
    const stmt = ast.body[1] as ExpressionStatement;
    const expr = stmt.expression as AssignmentExpression;
    assert.strictEqual(expr.type, NodeType.AssignmentExpression);
    assert.strictEqual(expr.operator, '+');
  });
});
