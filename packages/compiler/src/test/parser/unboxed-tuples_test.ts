import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Unboxed Tuples', () => {
  test('parses unboxed tuple type annotation as return type', () => {
    const parser = new Parser('let f = (): (i32, boolean) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.type, NodeType.FunctionExpression);
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnboxedTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 2);
    assert.strictEqual(returnType.elementTypes[0].name, 'i32');
    assert.strictEqual(returnType.elementTypes[1].name, 'boolean');
  });

  test('parses unboxed tuple with three elements', () => {
    const parser = new Parser('let f = (): (i32, i32, i32) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnboxedTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 3);
  });

  test('parses single element in parens as grouping (not tuple)', () => {
    const parser = new Parser('let f = (): (i32) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    // Single element in parens is just grouping, returns the inner type
    assert.strictEqual(returnType.type, NodeType.TypeAnnotation);
    assert.strictEqual(returnType.name, 'i32');
  });

  test('parses function type with arrow still works', () => {
    // Function type annotation on a variable with initializer
    const parser = new Parser(
      'let f: (i32, i32) => i32 = (a: i32, b: i32): i32 => a;',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.FunctionTypeAnnotation);
    assert.strictEqual(type.params.length, 2);
    assert.strictEqual(type.returnType.name, 'i32');
  });

  test('parses empty function type still works', () => {
    // Empty function type annotation
    const parser = new Parser('let f: () => void = (): void => {};');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.FunctionTypeAnnotation);
    assert.strictEqual(type.params.length, 0);
  });

  test('parses unboxed tuple in union', () => {
    const parser = new Parser('let f = (): (true, i32) | (false, never) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnionTypeAnnotation);
    assert.strictEqual(returnType.types.length, 2);
    assert.strictEqual(
      returnType.types[0].type,
      NodeType.UnboxedTupleTypeAnnotation,
    );
    assert.strictEqual(
      returnType.types[1].type,
      NodeType.UnboxedTupleTypeAnnotation,
    );
  });

  test('parses nested types in unboxed tuple', () => {
    const parser = new Parser('let f = (): (Box<i32>, array<i32>) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnboxedTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 2);
    // Generic types have typeArguments property
    assert.strictEqual(returnType.elementTypes[0].name, 'Box');
    assert.ok(returnType.elementTypes[0].typeArguments);
    assert.strictEqual(returnType.elementTypes[1].name, 'array');
    assert.ok(returnType.elementTypes[1].typeArguments);
  });
});
