import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Hex Literals', () => {
  test('should parse hex integer literals', () => {
    const input = 'let x = 0x10;';
    const parser = new Parser(input);
    const program = parser.parse();

    const decl = program.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.NumberLiteral);
      if (decl.init.type === NodeType.NumberLiteral) {
        assert.strictEqual(decl.init.value, 16);
        assert.strictEqual(decl.init.raw, '0x10');
      }
    }
  });

  test('should parse hex integer literals with uppercase X and digits', () => {
    const input = 'let x = 0XFF;';
    const parser = new Parser(input);
    const program = parser.parse();

    const decl = program.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.NumberLiteral);
      if (decl.init.type === NodeType.NumberLiteral) {
        assert.strictEqual(decl.init.value, 255);
        assert.strictEqual(decl.init.raw, '0XFF');
      }
    }
  });

  test('should parse decimal integer literals', () => {
    const input = 'let x = 123;';
    const parser = new Parser(input);
    const program = parser.parse();

    const decl = program.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.NumberLiteral);
      if (decl.init.type === NodeType.NumberLiteral) {
        assert.strictEqual(decl.init.value, 123);
        assert.strictEqual(decl.init.raw, '123');
      }
    }
  });

  test('should parse decimal float literals', () => {
    const input = 'let x = 12.34;';
    const parser = new Parser(input);
    const program = parser.parse();

    const decl = program.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.NumberLiteral);
      if (decl.init.type === NodeType.NumberLiteral) {
        assert.strictEqual(decl.init.value, 12.34);
        assert.strictEqual(decl.init.raw, '12.34');
      }
    }
  });

  test('should parse large hex integer literals', () => {
    const input = 'let x = 0x7FFFFFFF;';
    const parser = new Parser(input);
    const program = parser.parse();

    const decl = program.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.init.type, NodeType.NumberLiteral);
      if (decl.init.type === NodeType.NumberLiteral) {
        assert.strictEqual(decl.init.value, 2147483647);
        assert.strictEqual(decl.init.raw, '0x7FFFFFFF');
      }
    }
  });
});
