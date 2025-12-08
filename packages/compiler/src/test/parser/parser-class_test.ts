import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Classes', () => {
  test('should parse class with fields and methods', () => {
    const input = `
      class Point {
        x: i32;
        y: i32;
        distance(): i32 { return 0; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    if (classDecl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(classDecl.body.length, 3);
      assert.strictEqual(classDecl.body[0].type, NodeType.FieldDefinition);
      assert.strictEqual(classDecl.body[2].type, NodeType.MethodDefinition);
    }
  });

  test('should parse accessor with getter and setter', () => {
    const input = `
      class Circle {
        radius: f64 {
          get { return 1.0; }
          set(v) { }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    if (classDecl.type === NodeType.ClassDeclaration) {
      const accessor = classDecl.body[0];
      assert.strictEqual(accessor.type, NodeType.AccessorDeclaration);
      if (accessor.type === NodeType.AccessorDeclaration) {
        assert.strictEqual(accessor.name.type, NodeType.Identifier);
        if (accessor.name.type === NodeType.Identifier) {
          assert.strictEqual(accessor.name.name, 'radius');
        }
        assert.ok(accessor.getter);
        assert.ok(accessor.setter);
        assert.strictEqual(accessor.setter.param.name, 'v');
      }
    }
  });

  test('should parse accessor with only getter', () => {
    const input = `
      class Circle {
        area: f64 {
          get { return 0.0; }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    if (classDecl.type === NodeType.ClassDeclaration) {
      const accessor = classDecl.body[0];
      assert.strictEqual(accessor.type, NodeType.AccessorDeclaration);
      if (accessor.type === NodeType.AccessorDeclaration) {
        assert.ok(accessor.getter);
        assert.strictEqual(accessor.setter, undefined);
      }
    }
  });

  test('should parse accessor with only setter', () => {
    const input = `
      class Circle {
        radius: f64 {
          set(v) { }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    if (classDecl.type === NodeType.ClassDeclaration) {
      const accessor = classDecl.body[0];
      assert.strictEqual(accessor.type, NodeType.AccessorDeclaration);
      if (accessor.type === NodeType.AccessorDeclaration) {
        assert.strictEqual(accessor.getter, undefined);
        assert.ok(accessor.setter);
      }
    }
  });

  test('should fail on empty accessor block', () => {
    const input = `
      class Circle {
        radius: f64 {}
      }
    `;
    const parser = new Parser(input);
    assert.throws(
      () => parser.parse(),
      /Accessor must have at least a getter or a setter/,
    );
  });

  test('should fail on duplicate getter', () => {
    const input = `
      class Circle {
        radius: f64 {
          get { return 1.0; }
          get { return 2.0; }
        }
      }
    `;
    const parser = new Parser(input);
    assert.throws(() => parser.parse(), /Duplicate getter/);
  });

  test('should fail on duplicate setter', () => {
    const input = `
      class Circle {
        radius: f64 {
          set(v) { }
          set(x) { }
        }
      }
    `;
    const parser = new Parser(input);
    assert.throws(() => parser.parse(), /Duplicate setter/);
  });

  test('should fail on invalid keyword in accessor', () => {
    const input = `
      class Circle {
        radius: f64 {
          got { return 1.0; }
        }
      }
    `;
    const parser = new Parser(input);
    assert.throws(
      () => parser.parse(),
      /Expected 'get' or 'set' in accessor block/,
    );
  });

  test('should fail on missing setter parameter', () => {
    const input = `
      class Circle {
        radius: f64 {
          set { }
        }
      }
    `;
    const parser = new Parser(input);
    assert.throws(() => parser.parse(), /Expected '\(' after set/);
  });
});
