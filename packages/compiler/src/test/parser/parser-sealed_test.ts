import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {type ClassDeclaration, NodeType} from '../../lib/ast.js';

suite('Parser - Sealed Classes', () => {
  test('should parse sealed class with case variants', () => {
    const input = `
      sealed class Expr {
        case Binary, Literal, Ident
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    assert.strictEqual(classDecl.isSealed, true);
    assert.strictEqual(classDecl.isAbstract, false);
    assert.ok(classDecl.sealedVariants);
    assert.strictEqual(classDecl.sealedVariants!.length, 3);
    assert.strictEqual(classDecl.sealedVariants![0].name.name, 'Binary');
    assert.strictEqual(classDecl.sealedVariants![1].name.name, 'Literal');
    assert.strictEqual(classDecl.sealedVariants![2].name.name, 'Ident');
    // Unit variants have no params
    assert.strictEqual(classDecl.sealedVariants![0].params, undefined);
  });

  test('should parse sealed abstract class', () => {
    const input = `
      sealed abstract class Node {
        case Expr, Stmt
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.isSealed, true);
    assert.strictEqual(classDecl.isAbstract, true);
  });

  test('should parse inline case variants with params', () => {
    const input = `
      sealed class Expr {
        case Binary(left: Expr, op: i32, right: Expr)
        case Literal(value: i32)
        case Ident(name: string)
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.sealedVariants!.length, 3);

    const binary = classDecl.sealedVariants![0];
    assert.strictEqual(binary.name.name, 'Binary');
    assert.ok(binary.params);
    assert.strictEqual(binary.params!.length, 3);
    assert.strictEqual(binary.params![0].name.name, 'left');
    assert.strictEqual(binary.params![1].name.name, 'op');
    assert.strictEqual(binary.params![2].name.name, 'right');

    const literal = classDecl.sealedVariants![1];
    assert.strictEqual(literal.name.name, 'Literal');
    assert.strictEqual(literal.params!.length, 1);

    const ident = classDecl.sealedVariants![2];
    assert.strictEqual(ident.name.name, 'Ident');
    assert.strictEqual(ident.params!.length, 1);
  });

  test('should parse mixed unit and param variants', () => {
    const input = `
      sealed class Token {
        case Plus, Minus, Star
        case Number(value: i32)
        case Ident(name: string)
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.sealedVariants!.length, 5);
    assert.strictEqual(classDecl.sealedVariants![0].params, undefined);
    assert.strictEqual(classDecl.sealedVariants![1].params, undefined);
    assert.strictEqual(classDecl.sealedVariants![2].params, undefined);
    assert.strictEqual(classDecl.sealedVariants![3].params!.length, 1);
    assert.strictEqual(classDecl.sealedVariants![4].params!.length, 1);
  });

  test('should parse sealed class with body members', () => {
    const input = `
      sealed class Expr {
        case Binary, Literal

        eval(): i32 { return 0; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.sealedVariants!.length, 2);
    assert.strictEqual(classDecl.body.length, 1);
    assert.strictEqual(classDecl.body[0].type, NodeType.MethodDefinition);
  });

  test('should parse sealed class with case params with var', () => {
    const input = `
      sealed class Counter {
        case Inc(var amount: i32)
        case Reset
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.sealedVariants!.length, 2);
    const inc = classDecl.sealedVariants![0];
    assert.strictEqual(inc.params![0].mutability, 'var');
  });

  test('should parse exported sealed class', () => {
    const input = `
      export sealed class Expr {
        case Binary, Literal
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.exported, true);
    assert.strictEqual(classDecl.isSealed, true);
    assert.strictEqual(classDecl.sealedVariants!.length, 2);
  });

  test('should parse sealed class with case class params', () => {
    const input = `
      sealed class Expr(loc: i32) {
        case Binary, Literal
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0] as ClassDeclaration;

    assert.strictEqual(classDecl.isSealed, true);
    assert.ok(classDecl.caseParams);
    assert.strictEqual(classDecl.caseParams!.length, 1);
    assert.ok(classDecl.sealedVariants);
    assert.strictEqual(classDecl.sealedVariants!.length, 2);
  });
});
