import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Literal Types', () => {
  test('should parse string literal type', () => {
    const input = "let x: 'hello' = 'hello';";
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation;
      assert.ok(type);
      assert.strictEqual(type.type, NodeType.LiteralTypeAnnotation);
      if (type.type === NodeType.LiteralTypeAnnotation) {
        assert.strictEqual(type.value, 'hello');
      }
    }
  });

  test('should parse number literal type', () => {
    const input = 'let x: 42 = 42;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation;
      assert.ok(type);
      assert.strictEqual(type.type, NodeType.LiteralTypeAnnotation);
      if (type.type === NodeType.LiteralTypeAnnotation) {
        assert.strictEqual(type.value, 42);
      }
    }
  });

  test('should parse boolean literal type - true', () => {
    const input = 'let x: true = true;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation;
      assert.ok(type);
      assert.strictEqual(type.type, NodeType.LiteralTypeAnnotation);
      if (type.type === NodeType.LiteralTypeAnnotation) {
        assert.strictEqual(type.value, true);
      }
    }
  });

  test('should parse boolean literal type - false', () => {
    const input = 'let x: false = false;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation;
      assert.ok(type);
      assert.strictEqual(type.type, NodeType.LiteralTypeAnnotation);
      if (type.type === NodeType.LiteralTypeAnnotation) {
        assert.strictEqual(type.value, false);
      }
    }
  });

  test('should parse union of string literal types', () => {
    const input = "let mode: 'replace' | 'append' = 'replace';";
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation;
      assert.ok(type);
      assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
      if (type.type === NodeType.UnionTypeAnnotation) {
        assert.strictEqual(type.types.length, 2);
        assert.strictEqual(type.types[0].type, NodeType.LiteralTypeAnnotation);
        assert.strictEqual(type.types[1].type, NodeType.LiteralTypeAnnotation);
        if (
          type.types[0].type === NodeType.LiteralTypeAnnotation &&
          type.types[1].type === NodeType.LiteralTypeAnnotation
        ) {
          assert.strictEqual(type.types[0].value, 'replace');
          assert.strictEqual(type.types[1].value, 'append');
        }
      }
    }
  });

  test('should parse union of number literal types', () => {
    const input = 'let x: 1 | 2 | 3 = 1;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation!;
      assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
      if (type.type === NodeType.UnionTypeAnnotation) {
        assert.strictEqual(type.types.length, 3);
        const t0 = type.types[0];
        const t1 = type.types[1];
        const t2 = type.types[2];
        assert.strictEqual(t0.type, NodeType.LiteralTypeAnnotation);
        assert.strictEqual(t1.type, NodeType.LiteralTypeAnnotation);
        assert.strictEqual(t2.type, NodeType.LiteralTypeAnnotation);
        if (
          t0.type === NodeType.LiteralTypeAnnotation &&
          t1.type === NodeType.LiteralTypeAnnotation &&
          t2.type === NodeType.LiteralTypeAnnotation
        ) {
          assert.strictEqual(t0.value, 1);
          assert.strictEqual(t1.value, 2);
          assert.strictEqual(t2.value, 3);
        }
      }
    }
  });

  test('should parse union of boolean literal types', () => {
    const input = 'let x: true | false = true;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation!;
      assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
      if (type.type === NodeType.UnionTypeAnnotation) {
        assert.strictEqual(type.types.length, 2);
        assert.strictEqual(type.types[0].type, NodeType.LiteralTypeAnnotation);
        assert.strictEqual(type.types[1].type, NodeType.LiteralTypeAnnotation);
      }
    }
  });

  test('should parse literal type in type alias', () => {
    const input = "type Mode = 'replace' | 'append';";
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.TypeAliasDeclaration);
    if (decl.type === NodeType.TypeAliasDeclaration) {
      const type = decl.typeAnnotation;
      assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
      if (type.type === NodeType.UnionTypeAnnotation) {
        assert.strictEqual(type.types.length, 2);
        assert.strictEqual(type.types[0].type, NodeType.LiteralTypeAnnotation);
        assert.strictEqual(type.types[1].type, NodeType.LiteralTypeAnnotation);
      }
    }
  });

  test('should parse literal type in function parameter', () => {
    const input = "let f = (mode: 'read' | 'write') => {};";
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      if (fn.type === NodeType.FunctionExpression) {
        const param = fn.params[0];
        const type = param.typeAnnotation;
        assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
      }
    }
  });
});
