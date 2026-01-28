import {suite, test} from 'node:test';
import {strict as assert} from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Super', () => {
  // Note: These tests check that `super` is parsed correctly as an expression.
  // While `super` is only valid inside a class (checked by the TypeChecker),
  // the Parser allows it in any expression position.

  test('should parse super constructor call (expression)', () => {
    const parser = new Parser('super(1, 2);');
    const module = parser.parse();
    const stmt = module.body[0] as any;
    const expr = stmt.expression;

    assert.equal(expr.type, NodeType.CallExpression);
    assert.equal(expr.callee.type, NodeType.SuperExpression);
    assert.equal(expr.arguments.length, 2);
  });

  test('should parse super method call (expression)', () => {
    const parser = new Parser('super.foo();');
    const module = parser.parse();
    const stmt = module.body[0] as any;
    const expr = stmt.expression;

    assert.equal(expr.type, NodeType.CallExpression);
    assert.equal(expr.callee.type, NodeType.MemberExpression);
    assert.equal(expr.callee.object.type, NodeType.SuperExpression);
    assert.equal(expr.callee.property.name, 'foo');
  });

  test('should parse super field access (expression)', () => {
    const parser = new Parser('super.field;');
    const module = parser.parse();
    const stmt = module.body[0] as any;
    const expr = stmt.expression;

    assert.equal(expr.type, NodeType.MemberExpression);
    assert.equal(expr.object.type, NodeType.SuperExpression);
    assert.equal(expr.property.name, 'field');
  });

  test('should parse super call inside class constructor', () => {
    const source = `
      class B extends A {
        #new() {
          super();
        }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const classDecl = module.body[0] as any;
    const constructor = classDecl.body[0];
    const body = constructor.body;
    const stmt = body.body[0];
    const expr = stmt.expression;

    assert.equal(expr.type, NodeType.CallExpression);
    assert.equal(expr.callee.type, NodeType.SuperExpression);
  });

  test('should parse super method call inside class method', () => {
    const source = `
      class B extends A {
        foo() {
          super.foo();
        }
      }
    `;
    const parser = new Parser(source);
    const module = parser.parse();
    const classDecl = module.body[0] as any;
    const method = classDecl.body[0];
    const body = method.body;
    const stmt = body.body[0];
    const expr = stmt.expression;

    assert.equal(expr.type, NodeType.CallExpression);
    assert.equal(expr.callee.type, NodeType.MemberExpression);
    assert.equal(expr.callee.object.type, NodeType.SuperExpression);
    assert.equal(expr.callee.property.name, 'foo');
  });
});
