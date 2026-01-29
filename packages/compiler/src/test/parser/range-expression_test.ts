import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Range expressions', () => {
  test('should parse bounded range a..b', () => {
    const input = 'let r = 1..10;';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    assert.strictEqual(module.body.length, 1);
    const decl = module.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    
    const init = (decl as any).initializer;
    assert.strictEqual(init.type, NodeType.RangeExpression);
    assert.ok(init.start);
    assert.ok(init.end);
    assert.strictEqual(init.start.type, NodeType.NumberLiteral);
    assert.strictEqual(init.start.value, 1);
    assert.strictEqual(init.end.type, NodeType.NumberLiteral);
    assert.strictEqual(init.end.value, 10);
  });

  test('should parse from range a..', () => {
    const input = 'let r = 5..;';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    const decl = module.body[0];
    const init = (decl as any).initializer;
    assert.strictEqual(init.type, NodeType.RangeExpression);
    assert.ok(init.start);
    assert.strictEqual(init.end, null);
    assert.strictEqual(init.start.type, NodeType.NumberLiteral);
    assert.strictEqual(init.start.value, 5);
  });

  test('should parse to range ..b', () => {
    const input = 'let r = ..10;';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    const decl = module.body[0];
    const init = (decl as any).initializer;
    assert.strictEqual(init.type, NodeType.RangeExpression);
    assert.strictEqual(init.start, null);
    assert.ok(init.end);
    assert.strictEqual(init.end.type, NodeType.NumberLiteral);
    assert.strictEqual(init.end.value, 10);
  });

  test('should parse full range ..', () => {
    const input = 'let r = ..;';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    const decl = module.body[0];
    const init = (decl as any).initializer;
    assert.strictEqual(init.type, NodeType.RangeExpression);
    assert.strictEqual(init.start, null);
    assert.strictEqual(init.end, null);
  });

  test('should parse range with expressions', () => {
    const input = 'let r = (x + 1)..(y - 1);';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    const decl = module.body[0];
    const init = (decl as any).initializer;
    assert.strictEqual(init.type, NodeType.RangeExpression);
    assert.ok(init.start);
    assert.ok(init.end);
    assert.strictEqual(init.start.type, NodeType.BinaryExpression);
    assert.strictEqual(init.end.type, NodeType.BinaryExpression);
  });

  test('should parse range in array context', () => {
    const input = 'let ranges = [1..5, 10..20];';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    const decl = module.body[0];
    const init = (decl as any).initializer;
    assert.strictEqual(init.type, NodeType.ArrayLiteral);
    assert.strictEqual(init.elements.length, 2);
    assert.strictEqual(init.elements[0].type, NodeType.RangeExpression);
    assert.strictEqual(init.elements[1].type, NodeType.RangeExpression);
  });

  test('should parse range in function call', () => {
    const input = 'process(0..100);';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    const stmt = module.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    const expr = (stmt as any).expression;
    assert.strictEqual(expr.type, NodeType.CallExpression);
    assert.strictEqual(expr.arguments.length, 1);
    assert.strictEqual(expr.arguments[0].type, NodeType.RangeExpression);
  });

  test('range should have lower precedence than arithmetic', () => {
    const input = 'let r = 1 + 2..10 - 3;';
    const parser = new Parser(input);
    const module = parser.parse();

    assert.ok(module);
    const decl = module.body[0];
    const init = (decl as any).initializer;
    // Should parse as (1 + 2)..(10 - 3)
    assert.strictEqual(init.type, NodeType.RangeExpression);
    assert.strictEqual(init.start.type, NodeType.BinaryExpression);
    assert.strictEqual(init.start.operator, '+');
    assert.strictEqual(init.end.type, NodeType.BinaryExpression);
    assert.strictEqual(init.end.operator, '-');
  });
});
