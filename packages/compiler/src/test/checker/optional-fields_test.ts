import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {TypeKind, type UnionType} from '../../lib/types.js';
import {type ClassDeclaration, type FieldDefinition, type InterfaceDeclaration, type MixinDeclaration} from '../../lib/ast.js';

suite('Checker - Optional Fields', () => {
  test('optional class field has nullable type', () => {
    const input = `
      class Bar { x: i32; new() : x = 0 {} }
      class Foo {
        bar?: Bar;
        new() {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    const classDecl = ast.body[1] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.ok(field.inferredType);
    assert.strictEqual(field.inferredType.kind, TypeKind.Union);
    const union = field.inferredType as UnionType;
    assert.strictEqual(union.types.length, 2);
    assert.strictEqual(union.types[0].kind, TypeKind.Class);
    assert.strictEqual(union.types[1].kind, TypeKind.Null);
  });

  test('optional interface field has nullable type', () => {
    const input = `
      class Bar { x: i32; new() : x = 0 {} }
      interface Foo {
        bar?: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    const ifaceDecl = ast.body[1] as InterfaceDeclaration;
    const field = ifaceDecl.body[0] as FieldDefinition;
    assert.ok(field.inferredType);
    assert.strictEqual(field.inferredType.kind, TypeKind.Union);
  });

  test('optional mixin field has nullable type', () => {
    const input = `
      class Bar { x: i32; new() : x = 0 {} }
      mixin Foo {
        bar?: Bar;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    const mixinDecl = ast.body[1] as MixinDeclaration;
    const field = mixinDecl.body[0] as FieldDefinition;
    assert.ok(field.inferredType);
    assert.strictEqual(field.inferredType.kind, TypeKind.Union);
  });

  test('optional primitive field is rejected', () => {
    const input = `
      class Foo {
        bar?: i32;
        new() {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.ok(errors.length > 0);
    assert.ok(errors.some(e => e.message.includes('primitive')));
  });

  test('non-optional class field is unchanged', () => {
    const input = `
      class Bar { x: i32; new() : x = 0 {} }
      class Foo {
        bar: Bar;
        new(b: Bar) : bar = b {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    const classDecl = ast.body[1] as ClassDeclaration;
    const field = classDecl.body[0] as FieldDefinition;
    assert.ok(field.inferredType);
    assert.strictEqual(field.inferredType.kind, TypeKind.Class);
  });
});
