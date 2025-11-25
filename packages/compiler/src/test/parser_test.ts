import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../lib/parser.js';
import {NodeType} from '../lib/ast.js';

suite('Parser', () => {
  test('should parse variable declaration', () => {
    const input = 'let x = 1;';
    const parser = new Parser(input);
    const ast = parser.parse();

    assert.strictEqual(ast.type, NodeType.Program);
    assert.strictEqual(ast.body.length, 1);

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.kind, 'let');
      assert.strictEqual(decl.identifier.name, 'x');
      assert.strictEqual(decl.init.type, NodeType.NumberLiteral);
      assert.strictEqual(decl.exported, false);
    }
  });

  test('should parse exported variable declaration', () => {
    const input = 'export let x = 1;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      assert.strictEqual(decl.kind, 'let');
      assert.strictEqual(decl.identifier.name, 'x');
      assert.strictEqual(decl.exported, true);
    }
  });
  test('should parse binary expression', () => {
    const input = 'x + 1;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const stmt = ast.body[0];
    assert.strictEqual(stmt.type, NodeType.ExpressionStatement);
    if (stmt.type === NodeType.ExpressionStatement) {
      assert.strictEqual(stmt.expression.type, NodeType.BinaryExpression);
    }
  });

  test('should parse arrow function', () => {
    const input = 'let add = (a: i32, b: i32) => a + b;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        assert.strictEqual(fn.params.length, 2);
        assert.strictEqual(fn.params[0].name.name, 'a');
        assert.strictEqual(fn.params[0].typeAnnotation.name, 'i32');
        assert.strictEqual(fn.body.type, NodeType.BinaryExpression);
      }
    }
  });

  test('should parse arrow function with block body', () => {
    const input = 'let add = (a: i32, b: i32) => { return a + b; };';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0];
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    if (decl.type === NodeType.VariableDeclaration) {
      const fn = decl.init;
      assert.strictEqual(fn.type, NodeType.FunctionExpression);
      if (fn.type === NodeType.FunctionExpression) {
        assert.strictEqual(fn.body.type, NodeType.BlockStatement);
        if (fn.body.type === NodeType.BlockStatement) {
          assert.strictEqual(fn.body.body.length, 1);
          const stmt = fn.body.body[0];
          assert.strictEqual(stmt.type, NodeType.ReturnStatement);
        }
      }
    }
  });

  test('should parse while loop', () => {
    const input = 'let main = () => { while (true) { } };';
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    if (func.type === NodeType.VariableDeclaration) {
      const body = func.init;
      assert.strictEqual(body.type, NodeType.FunctionExpression);
      if (body.type === NodeType.FunctionExpression) {
        assert.strictEqual(body.body.type, NodeType.BlockStatement);
        if (body.body.type === NodeType.BlockStatement) {
          assert.strictEqual(body.body.body.length, 1);
          const loop = body.body.body[0];
          assert.strictEqual(loop.type, NodeType.WhileStatement);
          if (loop.type === NodeType.WhileStatement) {
            assert.strictEqual(loop.test.type, NodeType.BooleanLiteral);
            assert.strictEqual(loop.body.type, NodeType.BlockStatement);
          }
        }
      }
    }
  });

  test('should parse assignment', () => {
    const input = 'let main = () => { var x = 1; x = 2; };';
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    if (func.type === NodeType.VariableDeclaration) {
      const body = func.init;
      assert.strictEqual(body.type, NodeType.FunctionExpression);
      if (body.type === NodeType.FunctionExpression) {
        assert.strictEqual(body.body.type, NodeType.BlockStatement);
        if (body.body.type === NodeType.BlockStatement) {
          assert.strictEqual(body.body.body.length, 2);
          const assignment = body.body.body[1];
          assert.strictEqual(assignment.type, NodeType.ExpressionStatement);
          if (assignment.type === NodeType.ExpressionStatement) {
            assert.strictEqual(
              assignment.expression.type,
              NodeType.AssignmentExpression,
            );
            const expr = assignment.expression;
            if (expr.type === NodeType.AssignmentExpression) {
              assert.strictEqual(expr.name.type, NodeType.Identifier);
              assert.strictEqual(expr.name.name, 'x');
              assert.strictEqual(expr.value.type, NodeType.NumberLiteral);
            }
          }
        }
      }
    }
  });

  test('should parse function call', () => {
    const input = 'let main = () => { add(1, 2); };';
    const parser = new Parser(input);
    const ast = parser.parse();

    const func = ast.body[0];
    assert.strictEqual(func.type, NodeType.VariableDeclaration);
    if (func.type === NodeType.VariableDeclaration) {
      const body = func.init;
      assert.strictEqual(body.type, NodeType.FunctionExpression);
      if (body.type === NodeType.FunctionExpression) {
        assert.strictEqual(body.body.type, NodeType.BlockStatement);
        if (body.body.type === NodeType.BlockStatement) {
          assert.strictEqual(body.body.body.length, 1);
          const callStmt = body.body.body[0];
          assert.strictEqual(callStmt.type, NodeType.ExpressionStatement);
          if (callStmt.type === NodeType.ExpressionStatement) {
            assert.strictEqual(
              callStmt.expression.type,
              NodeType.CallExpression,
            );
            const call = callStmt.expression;
            if (call.type === NodeType.CallExpression) {
              assert.strictEqual(call.callee.type, NodeType.Identifier);
              assert.strictEqual((call.callee as any).name, 'add');
              assert.strictEqual(call.arguments.length, 2);
            }
          }
        }
      }
    }
  });
});
