import {strict as assert} from 'node:assert';
import {suite, test} from 'node:test';
import {NodeType} from '../../lib/ast.js';
import {Parser} from '../../lib/parser.js';

suite('Parser: Function Types', () => {
  test('parses a simple function type', () => {
    const parser = new Parser('var f: (a: i32) => i32 = null;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;

    assert.equal(type.type, NodeType.FunctionTypeAnnotation);
    assert.equal(type.params.length, 1);
    assert.equal(type.params[0].name, 'i32');
    assert.equal(type.returnType.name, 'i32');
  });

  test('parses a function type with multiple parameters', () => {
    const parser = new Parser('var f: (a: i32, b: boolean) => void = null;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;

    assert.equal(type.type, NodeType.FunctionTypeAnnotation);
    assert.equal(type.params.length, 2);
    assert.equal(type.params[0].name, 'i32');
    assert.equal(type.params[1].name, 'boolean');
    assert.equal(type.returnType.name, 'void');
  });

  test('parses a function type with no parameters', () => {
    const parser = new Parser('var f: () => string = null;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;

    assert.equal(type.type, NodeType.FunctionTypeAnnotation);
    assert.equal(type.params.length, 0);
    assert.equal(type.returnType.name, 'string');
  });

  test('parses nested function types', () => {
    const parser = new Parser('var f: (cb: (x: i32) => void) => void = null;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;

    assert.equal(type.type, NodeType.FunctionTypeAnnotation);
    assert.equal(type.params.length, 1);

    const paramType = type.params[0];
    assert.equal(paramType.type, NodeType.FunctionTypeAnnotation);
    assert.equal(paramType.params.length, 1);
    assert.equal(paramType.returnType.name, 'void');
  });
});
