import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {NodeType} from '../lib/ast.js';

suite('Parser (Generics)', () => {
  test('should parse generic class declaration', () => {
    const input = 'class Map<K, V> { }';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(decl.name.name, 'Map');
      assert.ok(decl.typeParameters);
      assert.strictEqual(decl.typeParameters.length, 2);
      assert.strictEqual(decl.typeParameters[0].name, 'K');
      assert.strictEqual(decl.typeParameters[1].name, 'V');
    }
  });

  test('should parse generic function definition', () => {
    const input = 'let id = <T>(x: T) => x;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        assert.ok(fn.typeParameters);
        assert.strictEqual(fn.typeParameters.length, 1);
        assert.strictEqual(fn.typeParameters[0].name, 'T');
        assert.strictEqual(fn.params[0].typeAnnotation.name, 'T');
      }
    }
  });

  test('should parse generic class instantiation', () => {
    const input = 'let m = new Map<i32, string>();';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const expr = decl.init;
      assert.strictEqual(expr.type, NodeType.NewExpression);
      if (expr.type === NodeType.NewExpression) {
        assert.strictEqual(expr.callee.name, 'Map');
        assert.ok(expr.typeArguments);
        assert.strictEqual(expr.typeArguments.length, 2);
        assert.strictEqual(expr.typeArguments[0].name, 'i32');
        assert.strictEqual(expr.typeArguments[1].name, 'string');
      }
    }
  });

  test('should parse nested generic type annotation', () => {
    const input = 'class Container { field: Map<string, List<i32>>; }';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      const field = decl.body[0];
      assert.strictEqual(field.type, NodeType.FieldDefinition);
      if (field.type === NodeType.FieldDefinition) {
        const type = field.typeAnnotation;
        assert.strictEqual(type.name, 'Map');
        assert.ok(type.typeArguments);
        assert.strictEqual(type.typeArguments.length, 2);
        assert.strictEqual(type.typeArguments[0].name, 'string');

        const nested = type.typeArguments[1];
        assert.strictEqual(nested.name, 'List');
        assert.ok(nested.typeArguments);
        assert.strictEqual(nested.typeArguments.length, 1);
        assert.strictEqual(nested.typeArguments[0].name, 'i32');
      }
    }
  });
});
