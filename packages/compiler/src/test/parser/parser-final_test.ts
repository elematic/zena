import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {
  NodeType,
  type AccessorDeclaration,
  type ClassDeclaration,
  type FieldDefinition,
  type MethodDefinition,
} from '../../lib/ast.js';

suite('Parser - Final Modifier', () => {
  test('should parse final class', () => {
    const input = `
      final class Point {
        x: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    assert.strictEqual(classDecl.isFinal, true);
  });

  test('should parse non-final class', () => {
    const input = `
      class Point {
        x: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    assert.strictEqual(classDecl.isFinal, false);
  });

  test('should parse final field', () => {
    const input = `
      class Point {
        final x: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    const field = classDecl.body[0] as FieldDefinition;
    assert.strictEqual(field.type, NodeType.FieldDefinition);
    assert.strictEqual(field.isFinal, true);
  });

  test('should parse final method', () => {
    const input = `
      class Point {
        final distance(): i32 { return 0; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    const method = classDecl.body[0] as MethodDefinition;
    assert.strictEqual(method.type, NodeType.MethodDefinition);
    assert.strictEqual(method.isFinal, true);
  });

  test('should parse final accessor', () => {
    const input = `
      class Point {
        final x: i32 {
          get { return 0; }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    const accessor = classDecl.body[0] as AccessorDeclaration;
    assert.strictEqual(accessor.type, NodeType.AccessorDeclaration);
    assert.strictEqual(accessor.isFinal, true);
  });
});
