import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Private Fields', () => {
  test('should parse private field declaration', () => {
    const input = `
      class Point {
        #x: i32;
        #y: i32;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as any;

    assert.strictEqual(classDecl.body.length, 2);
    assert.strictEqual(classDecl.body[0].type, NodeType.FieldDefinition);
    assert.strictEqual(classDecl.body[0].name.name, '#x');
    assert.strictEqual(classDecl.body[1].name.name, '#y');
  });

  test('should parse private field with initializer', () => {
    const input = `
      class Counter {
        #count: i32 = 0;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as any;

    assert.strictEqual(classDecl.body[0].type, NodeType.FieldDefinition);
    assert.strictEqual(classDecl.body[0].name.name, '#count');
    assert.strictEqual(classDecl.body[0].value.type, NodeType.NumberLiteral);
  });

  test('should parse private method declaration', () => {
    const input = `
      class Service {
        #helper() {
          return 1;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as any;

    assert.strictEqual(classDecl.body[0].type, NodeType.MethodDefinition);
    assert.strictEqual(classDecl.body[0].name.name, '#helper');
  });

  test('should parse private member access', () => {
    const input = `
      class A {
        #val: i32;
        get() {
          return this.#val;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as any;
    const method = classDecl.body[1];
    const returnStmt = method.body.body[0];

    assert.strictEqual(returnStmt.argument.type, NodeType.MemberExpression);
    assert.strictEqual(returnStmt.argument.property.name, '#val');
  });

  test('should parse private member access on other instance', () => {
    const input = `
      class A {
        #val: i32;
        copy(other: A) {
          this.#val = other.#val;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as any;
    const method = classDecl.body[1];
    const assignment = method.body.body[0].expression;

    assert.strictEqual(assignment.left.type, NodeType.MemberExpression);
    assert.strictEqual(assignment.left.property.name, '#val');
    assert.strictEqual(assignment.value.type, NodeType.MemberExpression);
    assert.strictEqual(assignment.value.property.name, '#val');
  });
});
