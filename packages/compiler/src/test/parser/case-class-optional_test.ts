import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {type ClassDeclaration} from '../../lib/ast.js';

suite('Parser - Optional Case Class Parameters', () => {
  test('should parse optional case class parameter', () => {
    const input = `class Point(x: i32, y?: i32)`;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.ok(classDecl.caseParams);
    assert.strictEqual(classDecl.caseParams!.length, 2);

    const x = classDecl.caseParams![0];
    assert.strictEqual(x.name.name, 'x');
    assert.strictEqual(x.optional, undefined);

    const y = classDecl.caseParams![1];
    assert.strictEqual(y.name.name, 'y');
    assert.strictEqual(y.optional, true);
  });

  test('should parse all-optional case class parameters', () => {
    const input = `class Config(name?: String, value?: i32)`;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.ok(classDecl.caseParams);
    assert.strictEqual(classDecl.caseParams!.length, 2);
    assert.strictEqual(classDecl.caseParams![0].optional, true);
    assert.strictEqual(classDecl.caseParams![1].optional, true);
  });

  test('should parse optional with mutability', () => {
    const input = `class Mutable(var x?: i32)`;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.ok(classDecl.caseParams);
    const param = classDecl.caseParams![0];
    assert.strictEqual(param.name.name, 'x');
    assert.strictEqual(param.optional, true);
    assert.strictEqual(param.mutability, 'var');
  });

  test('should parse optional in sealed variant params', () => {
    const input = `
      sealed class Node {
        case Leaf(value: i32, label?: String)
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.ok(classDecl.sealedVariants);
    const variant = classDecl.sealedVariants![0];
    assert.ok(variant.params);
    assert.strictEqual(variant.params!.length, 2);
    assert.strictEqual(variant.params![0].optional, undefined);
    assert.strictEqual(variant.params![1].optional, true);
  });
});
