import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {
  CONSTRUCTOR_NAME,
  type ClassDeclaration,
  type MethodDefinition,
  NodeType,
} from '../../lib/ast.js';

suite('Parser - this.field constructor parameters', () => {
  test('simple this.field parameter', () => {
    const input = `
      class Foo {
        bar: i32;
        new(this.bar);
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);

    const ctor = classDecl.body[1] as MethodDefinition;
    assert.strictEqual(ctor.type, NodeType.MethodDefinition);
    assert.strictEqual((ctor.name as any).name, CONSTRUCTOR_NAME);

    // Parameter should have isThisParam flag and no type annotation
    assert.strictEqual(ctor.params.length, 1);
    assert.strictEqual(ctor.params[0].name.name, 'bar');
    assert.strictEqual(ctor.params[0].isThisParam, true);
    assert.strictEqual(ctor.params[0].typeAnnotation, undefined);

    // Should synthesize an initializer list entry
    assert.ok(ctor.initializerList);
    assert.strictEqual(ctor.initializerList!.length, 1);
    assert.strictEqual(ctor.initializerList![0].field.name, 'bar');
    assert.strictEqual((ctor.initializerList![0].value as any).name, 'bar');
  });

  test('multiple this.field parameters', () => {
    const input = `
      class Point {
        x: i32;
        y: i32;
        new(this.x, this.y);
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const ctor = classDecl.body[2] as MethodDefinition;

    assert.strictEqual(ctor.params.length, 2);
    assert.strictEqual(ctor.params[0].name.name, 'x');
    assert.strictEqual(ctor.params[0].isThisParam, true);
    assert.strictEqual(ctor.params[1].name.name, 'y');
    assert.strictEqual(ctor.params[1].isThisParam, true);

    assert.ok(ctor.initializerList);
    assert.strictEqual(ctor.initializerList!.length, 2);
  });

  test('mixed this.field and regular parameters', () => {
    const input = `
      class Rect {
        width: i32;
        height: i32;
        new(this.width, this.height, name: string) {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const ctor = classDecl.body[2] as MethodDefinition;

    assert.strictEqual(ctor.params.length, 3);
    assert.strictEqual(ctor.params[0].isThisParam, true);
    assert.strictEqual(ctor.params[1].isThisParam, true);
    assert.strictEqual(ctor.params[2].isThisParam, undefined);
    assert.strictEqual(ctor.params[2].name.name, 'name');

    // Only this.field params generate initializer entries
    assert.strictEqual(ctor.initializerList!.length, 2);
  });

  test('this.field with explicit initializer list', () => {
    const input = `
      class Foo {
        x: i32;
        y: i32;
        new(this.x) : y = 42 {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const ctor = classDecl.body[2] as MethodDefinition;

    // this.x should be prepended before the explicit y = 42
    assert.strictEqual(ctor.initializerList!.length, 2);
    assert.strictEqual(ctor.initializerList![0].field.name, 'x');
    assert.strictEqual(ctor.initializerList![1].field.name, 'y');
  });

  test('this.field with optional explicit type annotation', () => {
    const input = `
      class Foo {
        bar: i32;
        new(this.bar: i32);
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const ctor = classDecl.body[1] as MethodDefinition;

    assert.strictEqual(ctor.params[0].isThisParam, true);
    assert.ok(ctor.params[0].typeAnnotation);
  });
});
