import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: AST Locations', () => {
  test('should attach location to number literal', () => {
    const input = '42;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.NumberLiteral);
      assert.ok(expr.loc, 'NumberLiteral should have loc');
      assert.strictEqual(expr.loc!.line, 1);
      assert.strictEqual(expr.loc!.column, 1);
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 2);
    }
  });

  test('should attach location to string literal', () => {
    const input = '"hello";';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.StringLiteral);
      assert.ok(expr.loc, 'StringLiteral should have loc');
      assert.strictEqual(expr.loc!.line, 1);
      assert.strictEqual(expr.loc!.column, 1);
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 7);
    }
  });

  test('should attach location to identifier', () => {
    const input = 'foo;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.Identifier);
      assert.ok(expr.loc, 'Identifier should have loc');
      assert.strictEqual(expr.loc!.line, 1);
      assert.strictEqual(expr.loc!.column, 1);
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 3);
    }
  });

  test('should attach location to boolean literals', () => {
    const input = 'true;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.BooleanLiteral);
      assert.ok(expr.loc, 'BooleanLiteral should have loc');
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 4);
    }
  });

  test('should attach location to null literal', () => {
    const input = 'null;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.NullLiteral);
      assert.ok(expr.loc, 'NullLiteral should have loc');
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 4);
    }
  });

  test('should attach location to this expression', () => {
    const input = 'this;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.ThisExpression);
      assert.ok(expr.loc, 'ThisExpression should have loc');
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 4);
    }
  });

  test('should attach location to super expression', () => {
    const input = 'super;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.SuperExpression);
      assert.ok(expr.loc, 'SuperExpression should have loc');
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 5);
    }
  });

  test('should attach location to variable declaration', () => {
    const input = 'let x = 1;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    assert.ok(decl.loc, 'VariableDeclaration should have loc');
    assert.strictEqual(decl.loc!.line, 1);
    assert.strictEqual(decl.loc!.column, 1);
    assert.strictEqual(decl.loc!.start, 0);
    assert.strictEqual(decl.loc!.end, 10);
  });

  test('should attach location to array literal', () => {
    const input = '#[1, 2];';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.ArrayLiteral);
      assert.ok(expr.loc, 'ArrayLiteral should have loc');
      assert.strictEqual(expr.loc!.start, 0);
      assert.strictEqual(expr.loc!.end, 7);
    }
  });

  test('should track location across multiple lines', () => {
    const input = `let x = 1;
let y = 2;`;
    const parser = new Parser(input);
    const ast = parser.parse();

    // First declaration
    const decl1 = ast.body[0];
    assert.strictEqual(decl1.type, NodeType.VariableDeclaration);
    assert.ok(decl1.loc);
    assert.strictEqual(decl1.loc!.line, 1);

    // Second declaration
    const decl2 = ast.body[1];
    assert.strictEqual(decl2.type, NodeType.VariableDeclaration);
    assert.ok(decl2.loc);
    assert.strictEqual(decl2.loc!.line, 2);
  });

  test('identifier from parseIdentifier should have location', () => {
    const input = 'let myVar = 1;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.pattern.type, NodeType.Identifier);
      if (decl.pattern.type === NodeType.Identifier) {
        assert.ok(decl.pattern.loc, 'Pattern identifier should have loc');
        assert.strictEqual(decl.pattern.loc!.start, 4);
        assert.strictEqual(decl.pattern.loc!.end, 9);
      }
    }
  });
});
