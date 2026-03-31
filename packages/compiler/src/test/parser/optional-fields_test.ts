import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {
  NodeType,
  type ClassDeclaration,
  type FieldDefinition,
  type InterfaceDeclaration,
  type MixinDeclaration,
} from '../../lib/ast.js';

suite('Parser - Optional Fields', () => {
  test('should parse optional class field', () => {
    const input = `
      class Foo {
        bar?: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;

    assert.strictEqual(field.type, NodeType.FieldDefinition);
    assert.strictEqual((field.name as any).name, 'bar');
    assert.strictEqual(field.isOptional, true);
    assert.strictEqual((field.typeAnnotation as any)?.name, 'Bar');
  });

  test('should parse non-optional class field', () => {
    const input = `
      class Foo {
        bar: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;

    assert.strictEqual(field.type, NodeType.FieldDefinition);
    assert.strictEqual(field.isOptional, undefined);
  });

  test('should parse optional var field', () => {
    const input = `
      class Foo {
        var bar?: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;

    assert.strictEqual(field.isOptional, true);
    assert.strictEqual(field.mutability, 'var');
  });

  test('should parse optional abstract field', () => {
    const input = `
      abstract class Foo {
        abstract bar?: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;

    assert.strictEqual(field.isOptional, true);
    assert.strictEqual(field.isAbstract, true);
  });

  test('should parse optional interface field', () => {
    const input = `
      interface Foo {
        bar?: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const ifaceDecl = ast.body[0] as InterfaceDeclaration;
    const field = ifaceDecl.body[0] as FieldDefinition;

    assert.strictEqual(field.type, NodeType.FieldDefinition);
    assert.strictEqual(field.isOptional, true);
    assert.strictEqual((field.typeAnnotation as any)?.name, 'Bar');
  });

  test('should parse optional mixin field', () => {
    const input = `
      mixin Foo {
        bar?: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const mixinDecl = ast.body[0] as MixinDeclaration;
    const field = mixinDecl.body[0] as FieldDefinition;

    assert.strictEqual(field.type, NodeType.FieldDefinition);
    assert.strictEqual(field.isOptional, true);
    assert.strictEqual((field.typeAnnotation as any)?.name, 'Bar');
  });

  test('should reject optional field with accessor block', () => {
    const input = `
      class Foo {
        bar?: Bar {
          get;
        }
      }
    `;
    const parser = new Parser(input);
    assert.throws(
      () => parser.parse(),
      /Optional fields cannot have accessor blocks/,
    );
  });

  test('should reject optional field without type annotation', () => {
    const input = `
      class Foo {
        bar? = something;
      }
    `;
    const parser = new Parser(input);
    assert.throws(
      () => parser.parse(),
      /Optional fields must have a type annotation/,
    );
  });
});
