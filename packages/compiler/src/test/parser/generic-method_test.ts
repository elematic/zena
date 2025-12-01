import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser (Generic Methods)', () => {
  test('should parse generic method in class', () => {
    const input = `
      class Test {
        method<T>(arg: T): T {
          return arg;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.ClassDeclaration);
    if (decl.type === NodeType.ClassDeclaration) {
      const method = decl.body[0];
      assert.strictEqual(method.type, NodeType.MethodDefinition);
      if (method.type === NodeType.MethodDefinition) {
        assert.strictEqual(method.name.name, 'method');
        assert.ok(method.typeParameters);
        assert.strictEqual(method.typeParameters.length, 1);
        assert.strictEqual(method.typeParameters[0].name, 'T');
      }
    }
  });

  test('should parse generic method in mixin', () => {
    const input = `
      mixin TestMixin {
        method<T>(arg: T): T {
          return arg;
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.MixinDeclaration);
    if (decl.type === NodeType.MixinDeclaration) {
      const method = decl.body[0];
      assert.strictEqual(method.type, NodeType.MethodDefinition);
      if (method.type === NodeType.MethodDefinition) {
        assert.strictEqual(method.name.name, 'method');
        assert.ok(method.typeParameters);
        assert.strictEqual(method.typeParameters.length, 1);
        assert.strictEqual(method.typeParameters[0].name, 'T');
      }
    }
  });
});
