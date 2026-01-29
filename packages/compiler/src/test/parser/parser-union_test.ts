import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Union Types', () => {
  test('should parse union type in variable declaration', () => {
    const input = 'let x: i32 | string = 10;';
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
        assert.strictEqual((type.types[0] as any).name, 'i32');
        assert.strictEqual((type.types[1] as any).name, 'string');
      }
    }
  });

  test('should parse union type in function parameter', () => {
    const input = 'let f = (x: i32 | boolean) => {};';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      if (fn.type === NodeType.FunctionExpression) {
        const param = fn.params[0];
        const type = param.typeAnnotation!;
        assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
        if (type.type === NodeType.UnionTypeAnnotation) {
          assert.strictEqual(type.types.length, 2);
          assert.strictEqual((type.types[0] as any).name, 'i32');
          assert.strictEqual((type.types[1] as any).name, 'boolean');
        }
      }
    }
  });

  test('should parse union type in class field', () => {
    const input = `
      class Box {
        value: i32 | null;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.ClassDeclaration) {
      const field = decl.body[0];
      if (field.type === NodeType.FieldDefinition) {
        const type = field.typeAnnotation;
        assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
        if (type.type === NodeType.UnionTypeAnnotation) {
          assert.strictEqual(type.types.length, 2);
          assert.strictEqual((type.types[0] as any).name, 'i32');
          assert.strictEqual((type.types[1] as any).name, 'null');
        }
      }
    }
  });

  test('should parse multi-type union', () => {
    const input = 'let x: A | B | C = null;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    if (decl.type === NodeType.VariableDeclaration) {
      const type = decl.typeAnnotation!;
      assert.strictEqual(type.type, NodeType.UnionTypeAnnotation);
      if (type.type === NodeType.UnionTypeAnnotation) {
        assert.strictEqual(type.types.length, 3);
      }
    }
  });
});
