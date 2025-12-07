import {suite, test} from 'node:test';
import {NodeType} from '../../lib/ast.js';
import {Parser} from '../../lib/parser.js';
import assert from 'node:assert';

suite('Parser: Identifiers', () => {
  function parseStatement(source: string) {
    const parser = new Parser(source);
    const program = parser.parse();
    return program.body[0];
  }

  function parseExpression(source: string) {
    const stmt = parseStatement(source + ';');
    if (stmt.type === NodeType.ExpressionStatement) {
      return stmt.expression;
    }
    throw new Error('Expected expression statement');
  }

  const allowedKeywords = [
    'from',
    'type',
    'as',
    'is',
    'on',
    'abstract',
    'declare',
    'mixin',
    'operator',
    'static',
    'extension',
    'distinct',
    'final',
    'extends',
    'implements',
    'with',
    'case',
    'match',
    'throw',
  ];

  for (const keyword of allowedKeywords) {
    test(`allows '${keyword}' as a variable name`, () => {
      const source = `let ${keyword} = 1;`;
      const stmt = parseStatement(source);
      assert.strictEqual(stmt.type, NodeType.VariableDeclaration);
      // @ts-ignore
      assert.strictEqual(stmt.pattern.name, keyword);
    });

    test(`allows '${keyword}' as a class member`, () => {
      const source = `class A { ${keyword}: i32; }`;
      const stmt = parseStatement(source);
      assert.strictEqual(stmt.type, NodeType.ClassDeclaration);
      // @ts-ignore
      assert.strictEqual(stmt.body[0].name.name, keyword);
    });

    test(`allows '${keyword}' as an interface member`, () => {
      const source = `interface A { ${keyword}: i32; }`;
      const stmt = parseStatement(source);
      assert.strictEqual(stmt.type, NodeType.InterfaceDeclaration);
      // @ts-ignore
      assert.strictEqual(stmt.body[0].name.name, keyword);
    });

    test(`allows '${keyword}' as a function parameter`, () => {
      const source = `(${keyword}: i32) => ${keyword}`;
      const expr = parseExpression(source);
      assert.strictEqual(expr.type, NodeType.FunctionExpression);
      // @ts-ignore
      assert.strictEqual(expr.params[0].name.name, keyword);
    });

    // Skip match/throw for expression start test as they are expression starters
    if (keyword !== 'match' && keyword !== 'throw') {
      test(`allows '${keyword}' in an expression`, () => {
        const source = `${keyword} + 1`;
        const expr = parseExpression(source);
        assert.strictEqual(expr.type, NodeType.BinaryExpression);
        // @ts-ignore
        assert.strictEqual(expr.left.name, keyword);
      });
    }
  }

  test('allows match as property name', () => {
    const source = `obj.match`;
    const expr = parseExpression(source);
    assert.strictEqual(expr.type, NodeType.MemberExpression);
    // @ts-ignore
    assert.strictEqual(expr.property.name, 'match');
  });

  test('allows throw as property name', () => {
    const source = `obj.throw`;
    const expr = parseExpression(source);
    assert.strictEqual(expr.type, NodeType.MemberExpression);
    // @ts-ignore
    assert.strictEqual(expr.property.name, 'throw');
  });
});
