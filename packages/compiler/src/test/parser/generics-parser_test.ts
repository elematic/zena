import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

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
        assert.strictEqual((fn.params[0].typeAnnotation as any).name, 'T');
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
        assert.strictEqual((expr.typeArguments[0] as any).name, 'i32');
        assert.strictEqual((expr.typeArguments[1] as any).name, 'string');
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
        const type = field.typeAnnotation as any;
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

  test('should parse generic class with constraint', () => {
    const input = 'class Foo<T extends Bar> { }';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(decl.name.name, 'Foo');
      assert.ok(decl.typeParameters);
      assert.strictEqual(decl.typeParameters.length, 1);
      assert.strictEqual(decl.typeParameters[0].name, 'T');
      assert.ok(decl.typeParameters[0].constraint);
      const constraint = decl.typeParameters[0].constraint as any;
      assert.strictEqual(constraint.name, 'Bar');
    }
  });

  test('should parse generic class with multiple constrained parameters', () => {
    const input = 'class Foo<T extends Bar<V>, V> { }';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(decl.name.name, 'Foo');
      assert.ok(decl.typeParameters);
      assert.strictEqual(decl.typeParameters.length, 2);

      // First parameter with generic constraint
      assert.strictEqual(decl.typeParameters[0].name, 'T');
      assert.ok(decl.typeParameters[0].constraint);
      const constraint = decl.typeParameters[0].constraint as any;
      assert.strictEqual(constraint.name, 'Bar');
      assert.ok(constraint.typeArguments);
      assert.strictEqual(constraint.typeArguments.length, 1);
      assert.strictEqual(constraint.typeArguments[0].name, 'V');

      // Second parameter without constraint
      assert.strictEqual(decl.typeParameters[1].name, 'V');
      assert.strictEqual(decl.typeParameters[1].constraint, undefined);
    }
  });

  test('should parse generic function with constraint', () => {
    const input = 'let fn = <T extends Base>(x: T) => x;';
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
        assert.ok(fn.typeParameters[0].constraint);
        const constraint = fn.typeParameters[0].constraint as any;
        assert.strictEqual(constraint.name, 'Base');
      }
    }
  });

  test('should parse type parameter with both constraint and default', () => {
    const input = 'type Foo<T extends Bar = Baz> = T;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.TypeAliasDeclaration);
    if (decl.type === NodeType.TypeAliasDeclaration) {
      assert.ok(decl.typeParameters);
      assert.strictEqual(decl.typeParameters.length, 1);
      assert.strictEqual(decl.typeParameters[0].name, 'T');
      assert.ok(decl.typeParameters[0].constraint);
      const constraint = decl.typeParameters[0].constraint as any;
      assert.strictEqual(constraint.name, 'Bar');
      assert.ok(decl.typeParameters[0].default);
      const defaultType = decl.typeParameters[0].default as any;
      assert.strictEqual(defaultType.name, 'Baz');
    }
  });
});
