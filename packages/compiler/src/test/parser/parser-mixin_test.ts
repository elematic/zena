import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Mixins', () => {
  test('should parse basic mixin declaration', () => {
    const input = `
      mixin Timestamped {
        timestamp: i32 = 0;
        getTimestamp(): i32 { return this.timestamp; }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const mixinDecl = ast.body[0];

    assert.strictEqual(mixinDecl.type, NodeType.MixinDeclaration);
    if (mixinDecl.type === NodeType.MixinDeclaration) {
      assert.strictEqual(mixinDecl.name.name, 'Timestamped');
      assert.strictEqual(mixinDecl.body.length, 2);
      assert.strictEqual(mixinDecl.body[0].type, NodeType.FieldDefinition);
      assert.strictEqual(mixinDecl.body[1].type, NodeType.MethodDefinition);
    }
  });

  test('should parse mixin with on clause', () => {
    const input = `
      mixin Syncable on Entity {
        sync(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const mixinDecl = ast.body[0];

    assert.strictEqual(mixinDecl.type, NodeType.MixinDeclaration);
    if (mixinDecl.type === NodeType.MixinDeclaration) {
      assert.strictEqual(mixinDecl.on?.name, 'Entity');
    }
  });

  test('should parse mixin composition', () => {
    const input = `
      mixin Composite with A, B {
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const mixinDecl = ast.body[0];

    assert.strictEqual(mixinDecl.type, NodeType.MixinDeclaration);
    if (mixinDecl.type === NodeType.MixinDeclaration) {
      assert.strictEqual(mixinDecl.mixins?.length, 2);
      assert.strictEqual(mixinDecl.mixins[0].type, NodeType.TypeAnnotation);
      assert.strictEqual((mixinDecl.mixins[0] as any).name, 'A');
      assert.strictEqual(mixinDecl.mixins[1].type, NodeType.TypeAnnotation);
      assert.strictEqual((mixinDecl.mixins[1] as any).name, 'B');
    }
  });

  test('should parse class with mixins', () => {
    const input = `
      class User extends Entity with Timestamped, Syncable {
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const classDecl = ast.body[0];

    assert.strictEqual(classDecl.type, NodeType.ClassDeclaration);
    if (classDecl.type === NodeType.ClassDeclaration) {
      assert.strictEqual(classDecl.superClass?.name, 'Entity');
      assert.strictEqual(classDecl.mixins?.length, 2);
      assert.strictEqual(classDecl.mixins[0].type, NodeType.TypeAnnotation);
      assert.strictEqual((classDecl.mixins[0] as any).name, 'Timestamped');
      assert.strictEqual(classDecl.mixins[1].type, NodeType.TypeAnnotation);
      assert.strictEqual((classDecl.mixins[1] as any).name, 'Syncable');
    }
  });
});
