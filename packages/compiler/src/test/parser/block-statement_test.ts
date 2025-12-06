import assert from 'node:assert';
import {describe, it} from 'node:test';
import {
  NodeType,
  type BlockStatement,
  type MatchExpression,
} from '../../lib/ast.js';
import {Parser} from '../../lib/parser.js';

describe('Parser: Match Case with Block', () => {
  it('parses match case with block body', () => {
    const source = `
      match (x) {
        case 1: {
          let y = 10;
          y + 1
        }
        case _: 0
      };
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const stmt = program.body[0] as any;
    const matchExpr = stmt.expression as MatchExpression;

    assert.strictEqual(matchExpr.cases.length, 2);

    const case1 = matchExpr.cases[0];
    assert.strictEqual(case1.body.type, NodeType.BlockStatement);
    const block = case1.body as BlockStatement;
    assert.strictEqual(block.body.length, 2);

    const case2 = matchExpr.cases[1];
    assert.strictEqual(case2.body.type, NodeType.NumberLiteral);
  });

  it('parses match case with block body and guard', () => {
    const source = `
      match (x) {
        case n if n > 0: {
          n * 2
        }
        case _: 0
      };
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const stmt = program.body[0] as any;
    const matchExpr = stmt.expression as MatchExpression;

    assert.strictEqual(matchExpr.cases.length, 2);

    const case1 = matchExpr.cases[0];
    assert.ok(case1.guard);
    assert.strictEqual(case1.body.type, NodeType.BlockStatement);
  });

  it('parses standalone block statement in function body', () => {
    const source = `
      let f = () => {
        var x = 0;
        {
          var x = 10;
          x = 20;
        }
        return x;
      };
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const decl = program.body[0] as any;
    const fn = decl.init;
    assert.strictEqual(fn.body.type, NodeType.BlockStatement);
    const fnBody = fn.body as BlockStatement;

    // Should have: var x = 0; { ... }; return x;
    assert.strictEqual(fnBody.body.length, 3);
    assert.strictEqual(fnBody.body[0].type, NodeType.VariableDeclaration);
    assert.strictEqual(fnBody.body[1].type, NodeType.BlockStatement);
    assert.strictEqual(fnBody.body[2].type, NodeType.ReturnStatement);

    // Inner block should have: var x = 10; x = 20;
    const innerBlock = fnBody.body[1] as BlockStatement;
    assert.strictEqual(innerBlock.body.length, 2);
  });
});
