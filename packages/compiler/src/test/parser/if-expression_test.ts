import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - If Expression', () => {
  test('should parse simple if expression', () => {
    const input = 'let x = if (true) { 1 } else { 2 };';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.IfExpression);
      if (decl.init.type === NodeType.IfExpression) {
        assert.strictEqual(decl.init.test.type, NodeType.BooleanLiteral);
        assert.strictEqual(decl.init.consequent.type, NodeType.BlockStatement);
        assert.strictEqual(decl.init.alternate.type, NodeType.BlockStatement);
      }
    }
  });

  test('should parse if expression without braces', () => {
    const input = 'let x = if (true) 1 else 2;';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.IfExpression);
      if (decl.init.type === NodeType.IfExpression) {
        assert.strictEqual(decl.init.test.type, NodeType.BooleanLiteral);
        assert.strictEqual(decl.init.consequent.type, NodeType.NumberLiteral);
        assert.strictEqual(decl.init.alternate.type, NodeType.NumberLiteral);
      }
    }
  });

  test('should parse nested if expressions (else if)', () => {
    const input = 'let x = if (a) 1 else if (b) 2 else 3;';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.IfExpression);
      if (decl.init.type === NodeType.IfExpression) {
        // The alternate should be another IfExpression
        assert.strictEqual(decl.init.alternate.type, NodeType.IfExpression);
      }
    }
  });

  test('should parse if expression with comparison', () => {
    const input = 'let result = if (x > 5) { x * 2 } else { x };';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.IfExpression);
      if (decl.init.type === NodeType.IfExpression) {
        assert.strictEqual(decl.init.test.type, NodeType.BinaryExpression);
      }
    }
  });

  test('should parse if expression in function body', () => {
    const input = 'let max = (a: i32, b: i32) => if (a > b) a else b;';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.FunctionExpression);
      if (decl.init.type === NodeType.FunctionExpression) {
        assert.strictEqual(decl.init.body.type, NodeType.IfExpression);
      }
    }
  });
});
