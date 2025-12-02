import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {Types} from '../../lib/types.js';

suite('Mixed Arithmetic', () => {
  test('should allow adding i32 and f32', () => {
    const input = 'let x = 1 + 2.5;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    // Check inferred type
    const varDecl = ast.body[0] as any;
    assert.strictEqual(varDecl.init.inferredType.name, 'f32');
  });

  test('should allow multiplying i32 and f32', () => {
    const input = 'let x = 1 * 2.5;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    const varDecl = ast.body[0] as any;
    assert.strictEqual(varDecl.init.inferredType.name, 'f32');
  });

  test('should allow multiplying f32 and i32', () => {
    const input = 'let x = 2.5 * 1;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    const varDecl = ast.body[0] as any;
    assert.strictEqual(varDecl.init.inferredType.name, 'f32');
  });

  test('should allow comparing i32 and f32', () => {
    const input = 'let x = 1 < 2.5;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);

    const varDecl = ast.body[0] as any;
    assert.strictEqual(varDecl.init.inferredType.kind, Types.Boolean.kind);
  });

  test('should NOT allow bitwise ops on f32', () => {
    const input = 'let x = 1 & 2.5;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /cannot be applied to type/);
  });
});
