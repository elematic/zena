import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {
  NodeType,
  type FunctionTypeAnnotation,
  type MethodSignature,
  type InterfaceDeclaration,
  type MethodDefinition,
  type ClassDeclaration,
} from '../../lib/ast.js';

suite('Parser: This Type', () => {
  test('should parse `this` type in interface method parameter', () => {
    const input = `
      interface Foo {
        method(other: this): void;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as InterfaceDeclaration;
    assert.strictEqual(decl.type, NodeType.InterfaceDeclaration);

    const method = decl.body[0] as MethodSignature;
    assert.strictEqual(method.type, NodeType.MethodSignature);
    assert.strictEqual(method.params[0].typeAnnotation?.type, NodeType.ThisTypeAnnotation);
  });

  test('should parse `this` type in interface method return type', () => {
    const input = `
      interface Builder {
        build(): this;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as InterfaceDeclaration;
    assert.strictEqual(decl.type, NodeType.InterfaceDeclaration);

    const method = decl.body[0] as MethodSignature;
    assert.strictEqual(method.type, NodeType.MethodSignature);
    assert.strictEqual(method.returnType?.type, NodeType.ThisTypeAnnotation);
  });

  test('should parse `this` type in class method parameter', () => {
    const input = `
      class Foo {
        compare(other: this): i32 {
          return 0;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as ClassDeclaration;
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);

    const method = decl.body[0] as MethodDefinition;
    assert.strictEqual(method.type, NodeType.MethodDefinition);
    assert.strictEqual(method.params[0].typeAnnotation?.type, NodeType.ThisTypeAnnotation);
  });

  test('should parse `this` type in class method return type', () => {
    const input = `
      class Builder {
        setValue(x: i32): this {
          return this;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as ClassDeclaration;
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);

    const method = decl.body[0] as MethodDefinition;
    assert.strictEqual(method.type, NodeType.MethodDefinition);
    assert.strictEqual(method.returnType?.type, NodeType.ThisTypeAnnotation);
  });

  test('should parse `this` type in function type annotation', () => {
    const input = `
      interface Sequence<T> {
        map<U>(f: (item: T, seq: this) => U): Sequence<U>;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as InterfaceDeclaration;
    assert.strictEqual(decl.type, NodeType.InterfaceDeclaration);

    const method = decl.body[0] as MethodSignature;
    assert.strictEqual(method.type, NodeType.MethodSignature);

    const funcType = method.params[0].typeAnnotation as FunctionTypeAnnotation;
    assert.strictEqual(funcType.type, NodeType.FunctionTypeAnnotation);
    assert.strictEqual(funcType.params[1].type, NodeType.ThisTypeAnnotation);
  });
});
