import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser - For Loops', () => {
  test('should parse basic for loop', () => {
    const input = `
      let main = () => {
        for (var i = 0; i < 10; i = i + 1) {
          x;
        }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    const fn = func.init;
    assert.strictEqual(fn.type, NodeType.FunctionExpression);
    assert.strictEqual(fn.body.type, NodeType.BlockStatement);
    assert.strictEqual(fn.body.body.length, 1);
    const forStmt = fn.body.body[0];
    assert.strictEqual(forStmt.type, NodeType.ForStatement);
    // Check init (var declaration)
    assert.ok(forStmt.init);
    assert.strictEqual(forStmt.init!.type, NodeType.VariableDeclaration);
    // Check test
    assert.ok(forStmt.test);
    assert.strictEqual(forStmt.test!.type, NodeType.BinaryExpression);
    // Check update
    assert.ok(forStmt.update);
    assert.strictEqual(forStmt.update!.type, NodeType.AssignmentExpression);
    // Check body
    assert.strictEqual(forStmt.body.type, NodeType.BlockStatement);
  });

  test('should parse for loop without init', () => {
    const input = `
      let main = () => {
        var i = 0;
        for (; i < 10; i = i + 1) { }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    const fn = func.init;
    assert.strictEqual(fn.type, NodeType.FunctionExpression);
    assert.strictEqual(fn.body.type, NodeType.BlockStatement);
    const forStmt = fn.body.body[1];
    assert.strictEqual(forStmt.type, NodeType.ForStatement);
    assert.strictEqual(forStmt.init, undefined);
    assert.ok(forStmt.test);
    assert.ok(forStmt.update);
  });

  test('should parse for loop without test', () => {
    const input = `
      let main = () => {
        for (var i = 0; ; i = i + 1) {
          return 0;
        }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    const fn = func.init;
    assert.strictEqual(fn.type, NodeType.FunctionExpression);
    assert.strictEqual(fn.body.type, NodeType.BlockStatement);
    const forStmt = fn.body.body[0];
    assert.strictEqual(forStmt.type, NodeType.ForStatement);
    assert.ok(forStmt.init);
    assert.strictEqual(forStmt.test, undefined);
    assert.ok(forStmt.update);
  });

  test('should parse for loop without update', () => {
    const input = `
      let main = () => {
        for (var i = 0; i < 10;) {
          i = i + 1;
        }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    const fn = func.init;
    assert.strictEqual(fn.type, NodeType.FunctionExpression);
    assert.strictEqual(fn.body.type, NodeType.BlockStatement);
    const forStmt = fn.body.body[0];
    assert.strictEqual(forStmt.type, NodeType.ForStatement);
    assert.ok(forStmt.init);
    assert.ok(forStmt.test);
    assert.strictEqual(forStmt.update, undefined);
  });

  test('should parse for loop with expression init', () => {
    const input = `
      let main = () => {
        var i = 0;
        for (i = 5; i < 10; i = i + 1) { }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    const fn = func.init;
    assert.strictEqual(fn.type, NodeType.FunctionExpression);
    assert.strictEqual(fn.body.type, NodeType.BlockStatement);
    const forStmt = fn.body.body[1];
    assert.strictEqual(forStmt.type, NodeType.ForStatement);
    assert.ok(forStmt.init);
    assert.strictEqual(forStmt.init!.type, NodeType.AssignmentExpression);
  });

  test('should parse empty for loop', () => {
    const input = `
      let main = () => {
        for (;;) {
          return 0;
        }
      };
    `;
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    const fn = func.init;
    assert.strictEqual(fn.type, NodeType.FunctionExpression);
    assert.strictEqual(fn.body.type, NodeType.BlockStatement);
    const forStmt = fn.body.body[0];
    assert.strictEqual(forStmt.type, NodeType.ForStatement);
    assert.strictEqual(forStmt.init, undefined);
    assert.strictEqual(forStmt.test, undefined);
    assert.strictEqual(forStmt.update, undefined);
  });
});
