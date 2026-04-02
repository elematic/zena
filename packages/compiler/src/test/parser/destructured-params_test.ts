import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';
import type {
  FunctionExpression,
  RecordPattern,
  TuplePattern,
  VariableDeclaration,
} from '../../lib/ast.js';

suite('Parser (Destructured Parameters)', () => {
  test('record destructured parameter in arrow function', () => {
    const input = 'let f = ({x, y}: Point) => x;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const fn = decl.init as FunctionExpression;
    assert.strictEqual(fn.params.length, 1);

    const param = fn.params[0];
    assert.ok(param.pattern);
    assert.strictEqual(param.pattern!.type, NodeType.RecordPattern);
    assert.strictEqual(param.name.name.startsWith('$$destruct_'), true);

    const pattern = param.pattern as RecordPattern;
    assert.strictEqual(pattern.properties.length, 2);
    assert.strictEqual(pattern.properties[0].name.name, 'x');
    assert.strictEqual(pattern.properties[1].name.name, 'y');

    assert.ok(param.typeAnnotation);
    assert.strictEqual((param.typeAnnotation as any).name, 'Point');
  });

  test('tuple destructured parameter in arrow function', () => {
    const input = 'let f = ((a, b): (i32, i32)) => a;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const fn = decl.init as FunctionExpression;
    assert.strictEqual(fn.params.length, 1);

    const param = fn.params[0];
    assert.ok(param.pattern);
    assert.strictEqual(param.pattern!.type, NodeType.TuplePattern);

    const pattern = param.pattern as TuplePattern;
    assert.strictEqual(pattern.elements.length, 2);
    assert.strictEqual((pattern.elements[0] as any).name, 'a');
    assert.strictEqual((pattern.elements[1] as any).name, 'b');
  });

  test('destructured parameter with default value', () => {
    const input = 'let f = ({x, y}: Point = defaultPoint) => x;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const fn = decl.init as FunctionExpression;
    const param = fn.params[0];
    assert.ok(param.pattern);
    assert.ok(param.initializer);
    assert.strictEqual(param.optional, true);
  });

  test('mixed destructured and normal parameters', () => {
    const input = 'let f = (a: i32, {x, y}: Point) => a;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const fn = decl.init as FunctionExpression;
    assert.strictEqual(fn.params.length, 2);
    assert.strictEqual(fn.params[0].pattern, undefined);
    assert.strictEqual(fn.params[0].name.name, 'a');
    assert.ok(fn.params[1].pattern);
  });

  test('destructured parameter requires type annotation', () => {
    const input = 'let f = ({x, y}) => x;';
    assert.throws(() => {
      const parser = new Parser(input);
      parser.parse();
    }, /type annotation/i);
  });

  test('record destructured parameter with renaming', () => {
    const input = 'let f = ({x as a, y as b}: Point) => a;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const fn = decl.init as FunctionExpression;
    const param = fn.params[0];
    const pattern = param.pattern as RecordPattern;
    assert.strictEqual(pattern.properties[0].name.name, 'x');
    assert.strictEqual((pattern.properties[0].value as any).name, 'a');
  });
});
