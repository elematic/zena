import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Pipeline', () => {
  test('should parse simple pipeline expression', () => {
    const input = '1 |> $ + 1;';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);

    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.PipelineExpression);

      if (expr.type === NodeType.PipelineExpression) {
        // Left side is number literal 1
        assert.strictEqual(expr.left.type, NodeType.NumberLiteral);

        // Right side is $ + 1
        assert.strictEqual(expr.right.type, NodeType.BinaryExpression);
        if (expr.right.type === NodeType.BinaryExpression) {
          assert.strictEqual(expr.right.left.type, NodeType.PipePlaceholder);
          assert.strictEqual(expr.right.operator, '+');
          assert.strictEqual(expr.right.right.type, NodeType.NumberLiteral);
        }
      }
    }
  });

  test('should parse chained pipeline expressions', () => {
    const input = '1 |> $ + 1 |> $ * 2;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);

    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.PipelineExpression);

      if (expr.type === NodeType.PipelineExpression) {
        // Left side is another pipeline (1 |> $ + 1)
        assert.strictEqual(expr.left.type, NodeType.PipelineExpression);

        // Right side is $ * 2
        assert.strictEqual(expr.right.type, NodeType.BinaryExpression);
      }
    }
  });

  test('should parse pipeline with function call', () => {
    const input = 'x |> f($);';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);

    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.PipelineExpression);

      if (expr.type === NodeType.PipelineExpression) {
        assert.strictEqual(expr.left.type, NodeType.Identifier);
        assert.strictEqual(expr.right.type, NodeType.CallExpression);

        if (expr.right.type === NodeType.CallExpression) {
          assert.strictEqual(expr.right.callee.type, NodeType.Identifier);
          assert.strictEqual(expr.right.arguments.length, 1);
          assert.strictEqual(
            expr.right.arguments[0].type,
            NodeType.PipePlaceholder,
          );
        }
      }
    }
  });

  test('should parse pipeline with multiple $ usages', () => {
    const input = '10 |> $ + $;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      if (expr.type === NodeType.PipelineExpression) {
        if (expr.right.type === NodeType.BinaryExpression) {
          assert.strictEqual(expr.right.left.type, NodeType.PipePlaceholder);
          assert.strictEqual(expr.right.right.type, NodeType.PipePlaceholder);
        }
      }
    }
  });

  test('should parse pipeline with method call on $', () => {
    const input = 'text |> $.trim();';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.PipelineExpression);

      if (expr.type === NodeType.PipelineExpression) {
        assert.strictEqual(expr.right.type, NodeType.CallExpression);
        if (expr.right.type === NodeType.CallExpression) {
          assert.strictEqual(expr.right.callee.type, NodeType.MemberExpression);
          if (expr.right.callee.type === NodeType.MemberExpression) {
            assert.strictEqual(
              expr.right.callee.object.type,
              NodeType.PipePlaceholder,
            );
          }
        }
      }
    }
  });

  test('should parse pipeline with index expression on $', () => {
    const input = 'tuple |> f($[0], $[1]);';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      if (expr.type === NodeType.PipelineExpression) {
        if (expr.right.type === NodeType.CallExpression) {
          // First argument: $[0]
          const arg0 = expr.right.arguments[0];
          assert.strictEqual(arg0.type, NodeType.IndexExpression);
          if (arg0.type === NodeType.IndexExpression) {
            assert.strictEqual(arg0.object.type, NodeType.PipePlaceholder);
          }

          // Second argument: $[1]
          const arg1 = expr.right.arguments[1];
          assert.strictEqual(arg1.type, NodeType.IndexExpression);
          if (arg1.type === NodeType.IndexExpression) {
            assert.strictEqual(arg1.object.type, NodeType.PipePlaceholder);
          }
        }
      }
    }
  });

  test('should parse pipeline in variable declaration', () => {
    const input = 'let result = x |> f($) |> g($);';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);

    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.PipelineExpression);
    }
  });
});
