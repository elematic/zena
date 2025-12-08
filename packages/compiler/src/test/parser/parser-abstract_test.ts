import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Abstract Classes', () => {
  test('should parse abstract class', () => {
    const input = `
      abstract class Shape {
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    if (classDecl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(classDecl.isAbstract, true);
      assert.strictEqual(classDecl.name.name, 'Shape');
    }
  });

  test('should parse abstract method', () => {
    const input = `
      abstract class Shape {
        abstract area(): i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    if (classDecl.type === NodeType.ClassDeclaration) {
      const method = classDecl.body[0];
      assert.strictEqual(method.type, NodeType.MethodDefinition);
      if (method.type === NodeType.MethodDefinition) {
        assert.strictEqual(method.isAbstract, true);
        assert.strictEqual(method.name.type, NodeType.Identifier);
        if (method.name.type === NodeType.Identifier) {
          assert.strictEqual(method.name.name, 'area');
        }
        assert.strictEqual(method.body, undefined);
      }
    }
  });

  test('should parse concrete method in abstract class', () => {
    const input = `
      abstract class Shape {
        getType(): string { return "Shape"; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    if (classDecl.type === NodeType.ClassDeclaration) {
      const method = classDecl.body[0];
      assert.strictEqual(method.type, NodeType.MethodDefinition);
      if (method.type === NodeType.MethodDefinition) {
        assert.strictEqual(method.isAbstract, false);
        assert.strictEqual(method.name.type, NodeType.Identifier);
        if (method.name.type === NodeType.Identifier) {
          assert.strictEqual(method.name.name, 'getType');
        }
        assert.ok(method.body);
      }
    }
  });

  test('should parse abstract class extending another class', () => {
    const input = `
      abstract class Shape extends Object {
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    if (classDecl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(classDecl.isAbstract, true);
      assert.strictEqual(classDecl.superClass?.name, 'Object');
    }
  });
});
