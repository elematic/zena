import {describe, it} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType, type MatchExpression} from '../../lib/ast.js';

describe('Parser: Match Guard', () => {
  it('parses match case with guard', () => {
    const source = `
      match (x) {
        case 1 if x > 0: true
        case _: false
      };
    `;
    const parser = new Parser(source);
    const program = parser.parse();
    const stmt = program.body[0] as any;
    const matchExpr = stmt.expression as MatchExpression;

    assert.strictEqual(matchExpr.cases.length, 2);

    const case1 = matchExpr.cases[0];
    assert.ok(case1.guard);
    assert.strictEqual(case1.guard.type, NodeType.BinaryExpression);

    const case2 = matchExpr.cases[1];
    assert.strictEqual(case2.guard, undefined);
  });
});
