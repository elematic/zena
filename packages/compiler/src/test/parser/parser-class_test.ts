import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {
  type ClassDeclaration,
  type FieldDefinition,
  type Identifier,
  type MethodDefinition,
  NodeType,
} from '../../lib/ast.js';

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

  test('should parse var field as mutable', () => {
    const input = `
      class Foo {
        var bar: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.strictEqual(field.mutability, 'var');
    assert.strictEqual(field.setterName, undefined);
  });

  test('should parse let field as explicitly immutable', () => {
    const input = `
      class Foo {
        let bar: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.strictEqual(field.mutability, 'let');
    assert.strictEqual(field.setterName, undefined);
  });

  test('should parse bare field as implicitly immutable', () => {
    const input = `
      class Foo {
        bar: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.strictEqual(field.mutability, undefined);
    assert.strictEqual(field.setterName, undefined);
  });

  test('should parse var with private setter name', () => {
    const input = `
      class Counter {
        var(#count) count: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.strictEqual(field.mutability, 'var');
    assert.ok(field.setterName);
    assert.strictEqual(field.setterName.type, NodeType.Identifier);
    assert.strictEqual((field.setterName as Identifier).name, '#count');
  });

  test('should parse var with explicit set: prefix', () => {
    const input = `
      class Counter {
        var(set: #value) value: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.strictEqual(field.mutability, 'var');
    assert.ok(field.setterName);
    assert.strictEqual((field.setterName as Identifier).name, '#value');
  });

  test('should allow field named var with colon', () => {
    const input = `
      class Foo {
        var: i32;
      }
    `;
    // var: i32 means field named "var" - var followed by : is the name
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    // Bare declaration (no mutability keyword)
    assert.strictEqual(field.mutability, undefined);
    assert.strictEqual((field.name as Identifier).name, 'var');
  });

  test('should allow field named let with colon', () => {
    const input = `
      class Foo {
        let: i32;
      }
    `;
    // let: i32 means field named "let"
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.strictEqual(field.mutability, undefined);
    assert.strictEqual((field.name as Identifier).name, 'let');
  });

  test('should reject setter name on non-var field', () => {
    const input = `
      class Foo {
        let(#bar) bar: i32;
      }
    `;
    const parser = new Parser(input);
    // let followed by ( is treated as let with paren expression, which will fail
    assert.throws(() => parser.parse());
  });

  test('should parse constructor with initializer list', () => {
    const input = `
      class Point {
        let x: i32;
        let y: i32;
        #new(x: i32, y: i32) : x = x, y = y { }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const ctor = classDecl.body[2] as MethodDefinition;
    assert.strictEqual((ctor.name as Identifier).name, '#new');
    assert.ok(ctor.initializerList);
    assert.strictEqual(ctor.initializerList.length, 2);
    assert.strictEqual(ctor.initializerList[0].field.name, 'x');
    assert.strictEqual(ctor.initializerList[1].field.name, 'y');
    // Check that values are identifiers
    assert.strictEqual(ctor.initializerList[0].value.type, NodeType.Identifier);
    assert.strictEqual(ctor.initializerList[1].value.type, NodeType.Identifier);
  });

  test('should parse initializer list with expressions', () => {
    const input = `
      class Rectangle {
        let area: i32;
        #new(width: i32, height: i32) : area = width * height { }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const ctor = classDecl.body[1] as MethodDefinition;
    assert.ok(ctor.initializerList);
    assert.strictEqual(ctor.initializerList.length, 1);
    assert.strictEqual(ctor.initializerList[0].field.name, 'area');
    // Value is a binary expression
    assert.strictEqual(
      ctor.initializerList[0].value.type,
      NodeType.BinaryExpression,
    );
  });
});
