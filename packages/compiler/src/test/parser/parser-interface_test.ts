import assert from 'node:assert';
import {suite, test} from 'node:test';
import {NodeType} from '../../lib/ast.js';
import {Parser} from '../../lib/parser.js';

suite('Parser - Interfaces', () => {
  test('should parse interface declaration', () => {
    const input = `
      interface Runnable {
        run(): void;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.InterfaceDeclaration);
    if (decl.type === NodeType.InterfaceDeclaration) {
      assert.strictEqual(decl.name.name, 'Runnable');
      assert.strictEqual(decl.body.length, 1);
      const method = decl.body[0];
      assert.strictEqual(method.type, NodeType.MethodSignature);
      if (method.type === NodeType.MethodSignature) {
        assert.strictEqual(method.name.name, 'run');
        assert.strictEqual(method.params.length, 0);
        assert.strictEqual((method.returnType as any)?.name, 'void');
      }
    }
  });

  test('should parse interface with fields', () => {
    const input = `
      interface Point {
        x: i32;
        y: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.InterfaceDeclaration) {
      assert.strictEqual(decl.body.length, 2);
      const field1 = decl.body[0];
      assert.strictEqual(field1.type, NodeType.FieldDefinition);
      if (field1.type === NodeType.FieldDefinition) {
        assert.strictEqual(field1.name.name, 'x');
        assert.strictEqual((field1.typeAnnotation as any).name, 'i32');
      }
    }
  });

  test('should parse class implementing interface', () => {
    const input = `
      class Task implements Runnable {
        run(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(decl.name.name, 'Task');
      assert.ok(decl.implements);
      assert.strictEqual(decl.implements.length, 1);
      assert.strictEqual((decl.implements[0] as any).name, 'Runnable');
    }
  });

  test('should parse class implementing multiple interfaces', () => {
    const input = `
      class Task implements Runnable, Stoppable {
        run(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.ClassDeclaration) {
      assert.ok(decl.implements);
      assert.strictEqual(decl.implements.length, 2);
      assert.strictEqual((decl.implements[0] as any).name, 'Runnable');
      assert.strictEqual((decl.implements[1] as any).name, 'Stoppable');
    }
  });

  test('should parse generic interface', () => {
    const input = `
      interface Box<T> {
        getValue(): T;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.InterfaceDeclaration) {
      assert.strictEqual(decl.name.name, 'Box');
      assert.ok(decl.typeParameters);
      assert.strictEqual(decl.typeParameters.length, 1);
      assert.strictEqual(decl.typeParameters[0].name, 'T');
    }
  });

  test('should parse interface with accessors', () => {
    const input = `
      interface Container {
        value: i32 { get; set; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.InterfaceDeclaration) {
      assert.strictEqual(decl.body.length, 1);

      const accessor = decl.body[0];
      assert.strictEqual(accessor.type, NodeType.AccessorSignature);
      if (accessor.type === NodeType.AccessorSignature) {
        assert.strictEqual(accessor.name.name, 'value');
        assert.strictEqual((accessor.typeAnnotation as any).name, 'i32');
        assert.strictEqual(accessor.hasGetter, true);
        assert.strictEqual(accessor.hasSetter, true);
      }
    }
  });

  test('should parse interface with getter only', () => {
    const input = `
      interface Container {
        value: i32 { get; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.InterfaceDeclaration) {
      const accessor = decl.body[0];
      if (accessor.type === NodeType.AccessorSignature) {
        assert.strictEqual(accessor.hasGetter, true);
        assert.strictEqual(accessor.hasSetter, false);
      }
    }
  });

  test('should parse interface with setter only', () => {
    const input = `
      interface Container {
        value: i32 { set; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.InterfaceDeclaration) {
      const accessor = decl.body[0];
      if (accessor.type === NodeType.AccessorSignature) {
        assert.strictEqual(accessor.hasGetter, false);
        assert.strictEqual(accessor.hasSetter, true);
      }
    }
  });
});
