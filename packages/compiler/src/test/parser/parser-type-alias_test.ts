import assert from 'node:assert';
import {suite, test} from 'node:test';
import {NodeType} from '../../lib/ast.js';
import {Parser} from '../../lib/parser.js';

suite('Parser - Type Aliases', () => {
  test('should parse basic type alias', () => {
    const input = 'type ID = string;';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.body.length, 1);
    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.TypeAliasDeclaration);
    assert.strictEqual(decl.name.name, 'ID');
    // @ts-ignore
    assert.strictEqual(decl.typeAnnotation.name, 'string');
  });

  test('should parse generic type alias', () => {
    const input = 'type Box<T> = { value: T };';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.TypeAliasDeclaration);
    // @ts-ignore
    assert.strictEqual(decl.typeParameters.length, 1);
    // @ts-ignore
    assert.strictEqual(decl.typeParameters[0].name, 'T');
  });

  test('should parse exported type alias', () => {
    const input = 'export type ID = string;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.TypeAliasDeclaration);
    // @ts-ignore
    assert.strictEqual(decl.exported, true);
  });
});
