import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Match Expression', () => {
  test('should parse simple match expression', () => {
    const input = 'let x = match (y) { case 1: 2 };';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.MatchExpression);
      if (decl.init.type === NodeType.MatchExpression) {
        assert.strictEqual(decl.init.cases.length, 1);
        assert.strictEqual(decl.init.cases[0].pattern.type, NodeType.NumberLiteral);
      }
    }
  });

  test('should parse match expression with multiple cases', () => {
    const input = `
      let x = match (y) {
        case 1: "one"
        case 2: "two"
        case _: "other"
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    if (decl.type === NodeType.VariableDeclaration && decl.init.type === NodeType.MatchExpression) {
      assert.strictEqual(decl.init.cases.length, 3);
    }
  });

  test('should allow optional semicolon for match expression statement', () => {
    const input = 'match (x) { case 1: 2 }';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      assert.strictEqual(stmt.expression.type, NodeType.MatchExpression);
    }
  });
});
