import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType, type DeclareFunction} from '../../lib/ast.js';

suite('Parser - Declare Function', () => {
  test('should parse simple declare function', () => {
    const source = 'declare function log(s: string): void;';
    const parser = new Parser(source);
    const program = parser.parse();

    assert.strictEqual(program.body.length, 1);
    const decl = program.body[0] as DeclareFunction;
    assert.strictEqual(decl.type, NodeType.DeclareFunction);
    assert.strictEqual(decl.name.name, 'log');
    assert.strictEqual(decl.params.length, 1);
    assert.strictEqual(decl.params[0].name.name, 's');
    assert.strictEqual((decl.params[0].typeAnnotation as any).name, 'string');
    assert.strictEqual((decl.returnType as any).name, 'void');
  });

  test('should parse decorated declare function', () => {
    const source =
      '@external("env", "print") declare function log(s: string): void;';
    const parser = new Parser(source);
    const program = parser.parse();

    assert.strictEqual(program.body.length, 1);
    const decl = program.body[0] as DeclareFunction;
    assert.strictEqual(decl.type, NodeType.DeclareFunction);
    assert.strictEqual(decl.name.name, 'log');
    assert.strictEqual(decl.externalModule, 'env');
    assert.strictEqual(decl.externalName, 'print');
  });
});
