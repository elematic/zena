import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';
import assert from 'node:assert';

suite('Parser: Try/Catch', () => {
  test('parses try/catch expression', () => {
    const parser = new Parser(`
      let x = try { 1 } catch (e) { 2 };
    `);
    const program = parser.parse();
    const varDecl = program.body[0] as any;
    assert.strictEqual(varDecl.type, NodeType.VariableDeclaration);
    const tryExpr = varDecl.init;
    assert.strictEqual(tryExpr.type, NodeType.TryExpression);
    assert.strictEqual(tryExpr.body.type, NodeType.BlockStatement);
    assert.notStrictEqual(tryExpr.handler, null);
    assert.strictEqual(tryExpr.handler.type, NodeType.CatchClause);
    assert.strictEqual(tryExpr.handler.param.name, 'e');
    assert.strictEqual(tryExpr.finalizer, null);
  });

  test('parses try/catch without parameter', () => {
    const parser = new Parser(`
      let x = try { 1 } catch { 2 };
    `);
    const program = parser.parse();
    const varDecl = program.body[0] as any;
    const tryExpr = varDecl.init;
    assert.strictEqual(tryExpr.type, NodeType.TryExpression);
    assert.notStrictEqual(tryExpr.handler, null);
    assert.strictEqual(tryExpr.handler.param, null);
  });

  test('parses try/finally expression', () => {
    const parser = new Parser(`
      let x = try { 1 } finally { cleanup() };
    `);
    const program = parser.parse();
    const varDecl = program.body[0] as any;
    const tryExpr = varDecl.init;
    assert.strictEqual(tryExpr.type, NodeType.TryExpression);
    assert.strictEqual(tryExpr.handler, null);
    assert.notStrictEqual(tryExpr.finalizer, null);
    assert.strictEqual(tryExpr.finalizer.type, NodeType.BlockStatement);
  });

  test('parses try/catch/finally expression', () => {
    const parser = new Parser(`
      let x = try { 1 } catch (e) { 2 } finally { cleanup() };
    `);
    const program = parser.parse();
    const varDecl = program.body[0] as any;
    const tryExpr = varDecl.init;
    assert.strictEqual(tryExpr.type, NodeType.TryExpression);
    assert.notStrictEqual(tryExpr.handler, null);
    assert.notStrictEqual(tryExpr.finalizer, null);
    assert.strictEqual(tryExpr.handler.param.name, 'e');
  });

  test('parses nested try expressions', () => {
    const parser = new Parser(`
      let x = try {
        try { inner() } catch (e) { 0 }
      } catch (outer) {
        1
      };
    `);
    const program = parser.parse();
    const varDecl = program.body[0] as any;
    const outerTry = varDecl.init;
    assert.strictEqual(outerTry.type, NodeType.TryExpression);
    assert.strictEqual(outerTry.handler.param.name, 'outer');

    // Find inner try in the body
    const innerExprStmt = outerTry.body.body[0] as any;
    const innerTry = innerExprStmt.expression;
    assert.strictEqual(innerTry.type, NodeType.TryExpression);
    assert.strictEqual(innerTry.handler.param.name, 'e');
  });

  test('try expression as function argument', () => {
    const parser = new Parser(`
      foo(try { 1 } catch (e) { 2 });
    `);
    const program = parser.parse();
    const exprStmt = program.body[0] as any;
    const callExpr = exprStmt.expression;
    assert.strictEqual(callExpr.type, NodeType.CallExpression);
    const arg = callExpr.arguments[0];
    assert.strictEqual(arg.type, NodeType.TryExpression);
  });

  test('try expression with throw inside', () => {
    const parser = new Parser(`
      let x = try {
        throw new Error("test");
        1
      } catch (e) {
        2
      };
    `);
    const program = parser.parse();
    const varDecl = program.body[0] as any;
    const tryExpr = varDecl.init;
    assert.strictEqual(tryExpr.type, NodeType.TryExpression);

    // First statement in try body should be throw
    const throwStmt = tryExpr.body.body[0] as any;
    assert.strictEqual(throwStmt.expression.type, NodeType.ThrowExpression);
  });

  test('error when no catch or finally', () => {
    const parser = new Parser(`
      let x = try { 1 };
    `);
    assert.throws(() => {
      parser.parse();
    }, /Expected 'catch' or 'finally'/);
  });

  test('should allow optional semicolon for try expression statement', () => {
    const parser = new Parser('try { 1 } catch { 2 }');
    const ast = parser.parse();
    assert.strictEqual(ast.body.length, 1);
    const stmt = ast.body[0] as any;
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    assert.strictEqual(stmt.expression.type, NodeType.TryExpression);
  });
});
