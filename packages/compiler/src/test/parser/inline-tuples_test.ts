import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Inline Tuples', () => {
  test('parses inline tuple type annotation as return type', () => {
    const parser = new Parser('let f = (): inline (i32, boolean) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.type, NodeType.FunctionExpression);
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.InlineTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 2);
    assert.strictEqual(returnType.elementTypes[0].name, 'i32');
    assert.strictEqual(returnType.elementTypes[1].name, 'boolean');
  });

  test('parses inline tuple with three elements', () => {
    const parser = new Parser('let f = (): inline (i32, i32, i32) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.InlineTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 3);
  });

  test('parses single element in parens as grouping (not tuple)', () => {
    const parser = new Parser('let f = (): (i32) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    // Single element in parens is just grouping, returns the inner type
    assert.strictEqual(returnType.type, NodeType.TypeAnnotation);
    assert.strictEqual(returnType.name, 'i32');
  });

  test('parses function type with arrow still works', () => {
    // Function type annotation on a variable with initializer
    const parser = new Parser(
      'let f: (i32, i32) => i32 = (a: i32, b: i32): i32 => a;',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.FunctionTypeAnnotation);
    assert.strictEqual(type.params.length, 2);
    assert.strictEqual(type.returnType.name, 'i32');
  });

  test('parses empty function type still works', () => {
    // Empty function type annotation
    const parser = new Parser('let f: () => void = (): void => {};');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.FunctionTypeAnnotation);
    assert.strictEqual(type.params.length, 0);
  });

  test('parses inline tuple in union', () => {
    const parser = new Parser(
      'let f = (): inline (true, i32) | inline (false, never) => 0;',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnionTypeAnnotation);
    assert.strictEqual(returnType.types.length, 2);
    assert.strictEqual(
      returnType.types[0].type,
      NodeType.InlineTupleTypeAnnotation,
    );
    assert.strictEqual(
      returnType.types[1].type,
      NodeType.InlineTupleTypeAnnotation,
    );
  });

  test('parses nested types in inline tuple', () => {
    const parser = new Parser(
      'let f = (): inline (Box<i32>, array<i32>) => 0;',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.InlineTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 2);
    // Generic types have typeArguments property
    assert.strictEqual(returnType.elementTypes[0].name, 'Box');
    assert.ok(returnType.elementTypes[0].typeArguments);
    assert.strictEqual(returnType.elementTypes[1].name, 'array');
    assert.ok(returnType.elementTypes[1].typeArguments);
  });

  test('rejects tuple type without inline modifier', () => {
    // (i32, i32) in type position without 'inline' should now be an error
    const parser = new Parser('let f = (): (i32, i32) => 0;');
    assert.throws(() => parser.parse(), /inline/);
  });

  test('inline keyword is required for tuple types in all positions', () => {
    // As variable type annotation (checker also rejects, but parser should require inline)
    const parser = new Parser('let x: inline (i32, i32) = (1, 2);');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(
      decl.typeAnnotation.type,
      NodeType.InlineTupleTypeAnnotation,
    );
  });
});

suite('Parser: Inline Tuple Destructuring', () => {
  test('parses basic inline tuple destructuring', () => {
    const parser = new Parser('let (a, b) = getTuple();');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    assert.strictEqual(decl.pattern.type, NodeType.InlineTuplePattern);
    assert.strictEqual(decl.pattern.elements.length, 2);
    assert.strictEqual(decl.pattern.elements[0].type, NodeType.Identifier);
    assert.strictEqual(decl.pattern.elements[0].name, 'a');
    assert.strictEqual(decl.pattern.elements[1].type, NodeType.Identifier);
    assert.strictEqual(decl.pattern.elements[1].name, 'b');
  });

  test('parses inline tuple destructuring with three elements', () => {
    const parser = new Parser('let (x, y, z) = getTriple();');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.pattern.type, NodeType.InlineTuplePattern);
    assert.strictEqual(decl.pattern.elements.length, 3);
  });

  test('parses single element in parens as grouping (not tuple pattern)', () => {
    const parser = new Parser('let (x) = getValue();');
    const module = parser.parse();
    const decl = module.body[0] as any;
    // Single element is just grouping, pattern is the inner identifier
    assert.strictEqual(decl.pattern.type, NodeType.Identifier);
    assert.strictEqual(decl.pattern.name, 'x');
  });

  test('parses inline tuple pattern with nested patterns', () => {
    const parser = new Parser('let (a, (b, c)) = nested();');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.pattern.type, NodeType.InlineTuplePattern);
    assert.strictEqual(decl.pattern.elements.length, 2);
    assert.strictEqual(decl.pattern.elements[0].name, 'a');
    assert.strictEqual(
      decl.pattern.elements[1].type,
      NodeType.InlineTuplePattern,
    );
    assert.strictEqual(decl.pattern.elements[1].elements.length, 2);
  });

  test('parses inline tuple pattern in match expression', () => {
    const parser = new Parser(`
      let x = 1;
      let result = match (x) {
        case (true, value): value
        case (false, _): 0
      };
    `);
    const module = parser.parse();
    const decl = module.body[1] as any;
    const match = decl.init;
    assert.strictEqual(match.type, NodeType.MatchExpression);
    // First case pattern should be inline tuple
    assert.strictEqual(
      match.cases[0].pattern.type,
      NodeType.InlineTuplePattern,
    );
    assert.strictEqual(match.cases[0].pattern.elements.length, 2);
  });
});

suite('Parser: Inline Tuple Expressions', () => {
  test('parses inline tuple expression as function body (double parens)', () => {
    // Double parens required: outer parens are grouping, inner parens are the tuple
    const parser = new Parser(
      'let f = (a: i32, b: i32): inline (i32, i32) => ((a, b));',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.type, NodeType.FunctionExpression);
    assert.strictEqual(func.body.type, NodeType.InlineTupleLiteral);
    assert.strictEqual(func.body.elements.length, 2);
    assert.strictEqual(func.body.elements[0].name, 'a');
    assert.strictEqual(func.body.elements[1].name, 'b');
  });

  test('parses inline tuple expression with expressions (double parens)', () => {
    const parser = new Parser(
      'let f = (a: i32, b: i32): inline (i32, i32) => ((a / b, a % b));',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const tuple = func.body;
    assert.strictEqual(tuple.type, NodeType.InlineTupleLiteral);
    assert.strictEqual(tuple.elements.length, 2);
    assert.strictEqual(tuple.elements[0].type, NodeType.BinaryExpression);
    assert.strictEqual(tuple.elements[1].type, NodeType.BinaryExpression);
  });

  test('parses inline tuple with three elements (double parens)', () => {
    const parser = new Parser(
      'let f = (): inline (i32, i32, i32) => ((1, 2, 3));',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const tuple = decl.init.body;
    assert.strictEqual(tuple.type, NodeType.InlineTupleLiteral);
    assert.strictEqual(tuple.elements.length, 3);
  });

  test('parses single element in parens as grouping (not tuple)', () => {
    const parser = new Parser('let x = (1 + 2);');
    const module = parser.parse();
    const decl = module.body[0] as any;
    // Single element is just grouping, returns the inner expression
    assert.strictEqual(decl.init.type, NodeType.BinaryExpression);
  });

  test('parses nested inline tuples (double parens)', () => {
    const parser = new Parser(
      'let f = (): inline (inline (i32, i32), i32) => (((1, 2), 3));',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const tuple = decl.init.body;
    assert.strictEqual(tuple.type, NodeType.InlineTupleLiteral);
    assert.strictEqual(tuple.elements.length, 2);
    assert.strictEqual(tuple.elements[0].type, NodeType.InlineTupleLiteral);
    assert.strictEqual(tuple.elements[1].type, NodeType.NumberLiteral);
  });

  test('parses inline tuple in return statement', () => {
    const parser = new Parser(`
      let f = (): inline (i32, i32) => {
        return (1, 2);
      };
    `);
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnStmt = func.body.body[0];
    assert.strictEqual(returnStmt.type, NodeType.ReturnStatement);
    assert.strictEqual(returnStmt.argument.type, NodeType.InlineTupleLiteral);
    assert.strictEqual(returnStmt.argument.elements.length, 2);
  });
});
