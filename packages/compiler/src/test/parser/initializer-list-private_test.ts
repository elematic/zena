import {test, suite} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {CONSTRUCTOR_NAME, NodeType} from '../../lib/ast.js';
import type {MethodDefinition, ClassDeclaration} from '../../lib/ast.js';

const parse = (source: string) => new Parser(source).parse();

suite('initializer list with private fields', () => {
  test('private field in initializer list', () => {
    const source = `
      class Point {
        #x: i32;
        #y: i32;
        new(x: i32, y: i32) : #x = x, #y = y { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);

    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.initializerList, 'Initializer list not found');
    assert.strictEqual(constructor.initializerList.length, 2);
    assert.strictEqual(constructor.initializerList[0].field.name, '#x');
    assert.strictEqual(constructor.initializerList[1].field.name, '#y');
  });

  test('mixed public and private fields in initializer list', () => {
    const source = `
      class Point {
        x: i32;
        #y: i32;
        new(x: i32, y: i32) : x = x, #y = y { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.initializerList, 'Initializer list not found');
    assert.strictEqual(constructor.initializerList.length, 2);
    assert.strictEqual(constructor.initializerList[0].field.name, 'x');
    assert.strictEqual(constructor.initializerList[1].field.name, '#y');
  });

  test('multi-line initializer list', () => {
    const source = `
      class Point {
        x: i32;
        y: i32;
        z: i32;
        new(x: i32, y: i32, z: i32) : 
          x = x,
          y = y,
          z = z
        { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.initializerList, 'Initializer list not found');
    assert.strictEqual(constructor.initializerList.length, 3);
  });

  test('multi-line initializer list with private fields', () => {
    const source = `
      class Point {
        #x: i32;
        #y: i32;
        #z: i32;
        new(x: i32, y: i32, z: i32) : 
          #x = x,
          #y = y,
          #z = z
        { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.initializerList, 'Initializer list not found');
    assert.strictEqual(constructor.initializerList.length, 3);
    assert.strictEqual(constructor.initializerList[0].field.name, '#x');
    assert.strictEqual(constructor.initializerList[1].field.name, '#y');
    assert.strictEqual(constructor.initializerList[2].field.name, '#z');
  });

  test('super() only in initializer list', () => {
    const source = `
      class Child extends Parent {
        new() : super() { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.superInitializer, 'Super initializer not found');
    assert.strictEqual(
      constructor.superInitializer.type,
      NodeType.SuperInitializer,
    );
    assert.strictEqual(constructor.superInitializer.arguments.length, 0);
    assert.strictEqual(constructor.initializerList?.length ?? 0, 0);
  });

  test('super() with arguments in initializer list', () => {
    const source = `
      class Child extends Parent {
        new(x: i32, y: i32) : super(x, y) { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.superInitializer, 'Super initializer not found');
    assert.strictEqual(constructor.superInitializer.arguments.length, 2);
  });

  test('field initializers followed by super()', () => {
    const source = `
      class Point3D extends Point {
        let z: i32;
        new(x: i32, y: i32, z: i32) : z = z, super(x, y) { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.initializerList, 'Initializer list not found');
    assert.strictEqual(constructor.initializerList.length, 1);
    assert.strictEqual(constructor.initializerList[0].field.name, 'z');
    assert(constructor.superInitializer, 'Super initializer not found');
    assert.strictEqual(constructor.superInitializer.arguments.length, 2);
  });

  test('multiple field initializers followed by super()', () => {
    const source = `
      class Derived extends Base {
        let a: i32;
        let b: i32;
        #c: i32;
        new(x: i32) : a = x, b = x * 2, #c = x + 1, super(x) { }
      }
    `;
    const ast = parse(source);
    const classDecl = ast.body[0] as ClassDeclaration;
    const constructor = classDecl.body.find(
      (m): m is MethodDefinition =>
        m.type === NodeType.MethodDefinition &&
        m.name.type === NodeType.Identifier &&
        m.name.name === CONSTRUCTOR_NAME,
    );
    assert(constructor, 'Constructor not found');
    assert(constructor.initializerList, 'Initializer list not found');
    assert.strictEqual(constructor.initializerList.length, 3);
    assert.strictEqual(constructor.initializerList[0].field.name, 'a');
    assert.strictEqual(constructor.initializerList[1].field.name, 'b');
    assert.strictEqual(constructor.initializerList[2].field.name, '#c');
    assert(constructor.superInitializer, 'Super initializer not found');
    assert.strictEqual(constructor.superInitializer.arguments.length, 1);
  });
});
