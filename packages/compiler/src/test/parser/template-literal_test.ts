import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Template Literals', () => {
  test('parses simple template literal', () => {
    const parser = new Parser('`hello world`;');
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TemplateLiteral);
      if (expr.type === NodeType.TemplateLiteral) {
        assert.strictEqual(expr.quasis.length, 1);
        assert.strictEqual(expr.expressions.length, 0);
        assert.strictEqual(expr.quasis[0].value.cooked, 'hello world');
        assert.strictEqual(expr.quasis[0].tail, true);
      }
    }
  });

  test('parses empty template literal', () => {
    const parser = new Parser('``;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TemplateLiteral);
      if (expr.type === NodeType.TemplateLiteral) {
        assert.strictEqual(expr.quasis.length, 1);
        assert.strictEqual(expr.quasis[0].value.cooked, '');
      }
    }
  });

  test('parses template literal with single substitution', () => {
    const parser = new Parser('`hello ${name}`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TemplateLiteral);
      if (expr.type === NodeType.TemplateLiteral) {
        assert.strictEqual(expr.quasis.length, 2);
        assert.strictEqual(expr.expressions.length, 1);
        assert.strictEqual(expr.quasis[0].value.cooked, 'hello ');
        assert.strictEqual(expr.quasis[0].tail, false);
        assert.strictEqual(expr.quasis[1].value.cooked, '');
        assert.strictEqual(expr.quasis[1].tail, true);

        const substExpr = expr.expressions[0];
        assert.strictEqual(substExpr.type, NodeType.Identifier);
        if (substExpr.type === NodeType.Identifier) {
          assert.strictEqual(substExpr.name, 'name');
        }
      }
    }
  });

  test('parses template literal with multiple substitutions', () => {
    const parser = new Parser('`${a} + ${b} = ${c}`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TemplateLiteral);
      if (expr.type === NodeType.TemplateLiteral) {
        assert.strictEqual(expr.quasis.length, 4);
        assert.strictEqual(expr.expressions.length, 3);

        assert.strictEqual(expr.quasis[0].value.cooked, '');
        assert.strictEqual(expr.quasis[1].value.cooked, ' + ');
        assert.strictEqual(expr.quasis[2].value.cooked, ' = ');
        assert.strictEqual(expr.quasis[3].value.cooked, '');

        assert.strictEqual(expr.quasis[0].tail, false);
        assert.strictEqual(expr.quasis[1].tail, false);
        assert.strictEqual(expr.quasis[2].tail, false);
        assert.strictEqual(expr.quasis[3].tail, true);
      }
    }
  });

  test('parses template literal with expression', () => {
    const parser = new Parser('`result: ${a + b}`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TemplateLiteral);
      if (expr.type === NodeType.TemplateLiteral) {
        assert.strictEqual(expr.expressions.length, 1);
        const binExpr = expr.expressions[0];
        assert.strictEqual(binExpr.type, NodeType.BinaryExpression);
      }
    }
  });

  test('parses tagged template literal', () => {
    const parser = new Parser('html`<div>content</div>`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TaggedTemplateExpression);
      if (expr.type === NodeType.TaggedTemplateExpression) {
        assert.strictEqual(expr.tag.type, NodeType.Identifier);
        if (expr.tag.type === NodeType.Identifier) {
          assert.strictEqual(expr.tag.name, 'html');
        }
        assert.strictEqual(expr.quasi.type, NodeType.TemplateLiteral);
        assert.strictEqual(
          expr.quasi.quasis[0].value.cooked,
          '<div>content</div>',
        );
      }
    }
  });

  test('parses tagged template with substitutions', () => {
    const parser = new Parser('sql`SELECT * FROM ${table} WHERE id = ${id}`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TaggedTemplateExpression);
      if (expr.type === NodeType.TaggedTemplateExpression) {
        assert.strictEqual(expr.tag.type, NodeType.Identifier);
        assert.strictEqual(expr.quasi.expressions.length, 2);
        assert.strictEqual(expr.quasi.quasis.length, 3);
        assert.strictEqual(expr.quasi.quasis[0].value.cooked, 'SELECT * FROM ');
        assert.strictEqual(expr.quasi.quasis[1].value.cooked, ' WHERE id = ');
        assert.strictEqual(expr.quasi.quasis[2].value.cooked, '');
      }
    }
  });

  test('parses tagged template with member expression tag', () => {
    const parser = new Parser('console.log`debug`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TaggedTemplateExpression);
      if (expr.type === NodeType.TaggedTemplateExpression) {
        assert.strictEqual(expr.tag.type, NodeType.MemberExpression);
      }
    }
  });

  test('preserves raw and cooked values', () => {
    const parser = new Parser('`line1\\nline2`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TemplateLiteral);
      if (expr.type === NodeType.TemplateLiteral) {
        assert.strictEqual(expr.quasis[0].value.cooked, 'line1\nline2');
        assert.strictEqual(expr.quasis[0].value.raw, 'line1\\nline2');
      }
    }
  });

  test('parses template literal in variable declaration', () => {
    const parser = new Parser('let greeting = `Hello, ${name}!`;');
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.TemplateLiteral);
    }
  });

  test('parses nested template in expression', () => {
    const parser = new Parser('`outer ${`inner`}`;');
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      const expr = stmt.expression;
      assert.strictEqual(expr.type, NodeType.TemplateLiteral);
      if (expr.type === NodeType.TemplateLiteral) {
        assert.strictEqual(expr.expressions.length, 1);
        const innerExpr = expr.expressions[0];
        assert.strictEqual(innerExpr.type, NodeType.TemplateLiteral);
      }
    }
  });
});
