import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import type {FunctionExpression} from '../../lib/ast.js';

suite('parser: contextual typing', () => {
  const parse = (source: string) => {
    const parser = new Parser(source);
    return parser.parse();
  };

  test('parses arrow function with untyped parameter', () => {
    const ast = parse('let f = (x) => x;');
    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0] as any;
    assert.strictEqual(decl.type, 'VariableDeclaration');
    const func = decl.init as FunctionExpression;
    assert.strictEqual(func.type, 'FunctionExpression');
    assert.strictEqual(func.params.length, 1);
    assert.strictEqual(func.params[0].name.name, 'x');
    // No type annotation
    assert.strictEqual(func.params[0].typeAnnotation, undefined);
  });

  test('parses arrow function with multiple untyped parameters', () => {
    const ast = parse('let f = (a, b) => a + b;');
    const decl = ast.body[0] as any;
    const func = decl.init as FunctionExpression;
    assert.strictEqual(func.params.length, 2);
    assert.strictEqual(func.params[0].name.name, 'a');
    assert.strictEqual(func.params[0].typeAnnotation, undefined);
    assert.strictEqual(func.params[1].name.name, 'b');
    assert.strictEqual(func.params[1].typeAnnotation, undefined);
  });

  test('parses arrow function with typed parameter (existing behavior)', () => {
    const ast = parse('let f = (x: i32) => x;');
    const decl = ast.body[0] as any;
    const func = decl.init as FunctionExpression;
    assert.strictEqual(func.params.length, 1);
    assert.strictEqual(func.params[0].name.name, 'x');
    assert.ok(func.params[0].typeAnnotation);
  });

  test('parses untyped closure as function argument', () => {
    const ast = parse('let r = apply((x) => x * 2, 5);');
    const decl = ast.body[0] as any;
    const call = decl.init;
    assert.strictEqual(call.type, 'CallExpression');
    const closure = call.arguments[0] as FunctionExpression;
    assert.strictEqual(closure.type, 'FunctionExpression');
    assert.strictEqual(closure.params[0].typeAnnotation, undefined);
  });

  test('parses empty parameter list (existing behavior)', () => {
    const ast = parse('let f = () => 42;');
    const decl = ast.body[0] as any;
    const func = decl.init as FunctionExpression;
    assert.strictEqual(func.params.length, 0);
  });
});
