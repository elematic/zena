import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Null Literal', () => {
  test('should parse null literal', () => {
    const input = 'let x = null;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const init = decl.init;
      assert.strictEqual(init.type, NodeType.NullLiteral);
    }
  });

  test('should parse null in binary expression', () => {
    const input = 'let x = y == null;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.VariableDeclaration) {
      const init = decl.init;
      assert.strictEqual(init.type, NodeType.BinaryExpression);
      if (init.type === NodeType.BinaryExpression) {
        assert.strictEqual(init.right.type, NodeType.NullLiteral);
      }
    }
  });

  test('should parse null as function argument', () => {
    const input = 'f(null);';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      if (expr.type === NodeType.CallExpression) {
        assert.strictEqual(expr.arguments.length, 1);
        assert.strictEqual(expr.arguments[0].type, NodeType.NullLiteral);
      }
    }
  });
});
