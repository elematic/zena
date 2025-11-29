import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - Decorators', () => {
  test('should parse @intrinsic decorator on method', () => {
    const input = `
      extension class Array on FixedArray<i32> {
        @intrinsic("array.len")
        length(): i32 {
          return 0;
        }
      }
    `;
    const parser = new Parser(input);
    const program = parser.parse();
    const classDecl = program.body[0] as any;
    const method = classDecl.body[0];

    assert.strictEqual(method.type, NodeType.MethodDefinition);
    assert.strictEqual(method.decorators.length, 1);
    assert.strictEqual(method.decorators[0].name, 'intrinsic');
    assert.strictEqual(method.decorators[0].args.length, 1);
    assert.strictEqual(method.decorators[0].args[0].value, 'array.len');
  });
});
