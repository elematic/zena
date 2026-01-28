import assert from 'node:assert';
import {suite, test} from 'node:test';
import {
  type FunctionExpression,
  type VariableDeclaration,
} from '../../lib/ast.js';
import {analyzeCaptures} from '../../lib/codegen/captures.js';
import {Parser} from '../../lib/parser.js';

suite('Capture Analysis', () => {
  test('captures variables from outer scope', () => {
    const input = 'let x = 1; let f = () => x;';
    const parser = new Parser(input);
    const module = parser.parse();
    const funcDecl = module.body[1] as VariableDeclaration;
    const func = funcDecl.init as FunctionExpression;

    const captures = analyzeCaptures(func);
    assert.ok(captures.has('x'));
    assert.strictEqual(captures.size, 1);
  });

  test('does not capture locals', () => {
    const input = 'let f = (x: i32) => x;';
    const parser = new Parser(input);
    const module = parser.parse();
    const funcDecl = module.body[0] as VariableDeclaration;
    const func = funcDecl.init as FunctionExpression;

    const captures = analyzeCaptures(func);
    assert.strictEqual(captures.size, 0);
  });

  test('does not capture internal variables', () => {
    const input = 'let f = () => { let x = 1; return x; };';
    const parser = new Parser(input);
    const module = parser.parse();
    const funcDecl = module.body[0] as VariableDeclaration;
    const func = funcDecl.init as FunctionExpression;

    const captures = analyzeCaptures(func);
    assert.strictEqual(captures.size, 0);
  });

  test('captures transitively from nested functions', () => {
    const input = 'let x = 1; let f = () => { let g = () => x; return g(); };';
    const parser = new Parser(input);
    const module = parser.parse();
    const funcDecl = module.body[1] as VariableDeclaration;
    const func = funcDecl.init as FunctionExpression;

    const captures = analyzeCaptures(func);
    assert.ok(captures.has('x'));
  });
});
