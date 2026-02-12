import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Enum Member Pattern', () => {
  test('should parse enum member pattern in match case', () => {
    const input = `
      let x = match (token) {
        case TokenType.Whitespace: "ws"
        case _: "other"
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.MatchExpression);
      if (decl.init.type === NodeType.MatchExpression) {
        assert.strictEqual(decl.init.cases.length, 2);

        // First case should be a MemberExpression pattern
        const firstPattern = decl.init.cases[0].pattern;
        assert.strictEqual(firstPattern.type, NodeType.MemberExpression);
        if (firstPattern.type === NodeType.MemberExpression) {
          assert.strictEqual(firstPattern.object.type, NodeType.Identifier);
          assert.strictEqual((firstPattern.object as any).name, 'TokenType');
          assert.strictEqual(firstPattern.property.name, 'Whitespace');
        }
      }
    }
  });

  test('should parse chained member expression pattern', () => {
    const input = `
      let x = match (v) {
        case A.B.C: 1
        case _: 2
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    if (
      decl.type === NodeType.VariableDeclaration &&
      decl.init.type === NodeType.MatchExpression
    ) {
      const firstPattern = decl.init.cases[0].pattern;
      assert.strictEqual(firstPattern.type, NodeType.MemberExpression);

      // A.B.C parses as ((A.B).C)
      if (firstPattern.type === NodeType.MemberExpression) {
        assert.strictEqual(firstPattern.property.name, 'C');
        assert.strictEqual(firstPattern.object.type, NodeType.MemberExpression);
        if (firstPattern.object.type === NodeType.MemberExpression) {
          assert.strictEqual(firstPattern.object.property.name, 'B');
          assert.strictEqual((firstPattern.object.object as any).name, 'A');
        }
      }
    }
  });

  test('should parse multiple enum member patterns', () => {
    const input = `
      let x = match (color) {
        case Color.Red: 1
        case Color.Green: 2
        case Color.Blue: 3
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    if (
      decl.type === NodeType.VariableDeclaration &&
      decl.init.type === NodeType.MatchExpression
    ) {
      assert.strictEqual(decl.init.cases.length, 3);

      for (const c of decl.init.cases) {
        assert.strictEqual(c.pattern.type, NodeType.MemberExpression);
      }
    }
  });

  test('should parse enum pattern with guard', () => {
    const input = `
      let x = match (token) {
        case TokenType.Number if value > 0: "positive"
        case TokenType.Number: "non-positive"
        case _: "other"
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (
      decl.type === NodeType.VariableDeclaration &&
      decl.init.type === NodeType.MatchExpression
    ) {
      // First case has a guard
      const firstCase = decl.init.cases[0];
      assert.strictEqual(firstCase.pattern.type, NodeType.MemberExpression);
      assert.ok(firstCase.guard);
      assert.strictEqual(firstCase.guard!.type, NodeType.BinaryExpression);
    }
  });
});
