import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Unboxed Tuples', () => {
  test('parses unboxed tuple type annotation as return type', () => {
    const parser = new Parser('let f = (): (i32, boolean) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.type, NodeType.FunctionExpression);
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnboxedTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 2);
    assert.strictEqual(returnType.elementTypes[0].name, 'i32');
    assert.strictEqual(returnType.elementTypes[1].name, 'boolean');
  });

  test('parses unboxed tuple with three elements', () => {
    const parser = new Parser('let f = (): (i32, i32, i32) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnboxedTupleTypeAnnotation);
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

  test('parses unboxed tuple in union', () => {
    const parser = new Parser('let f = (): (true, i32) | (false, never) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnionTypeAnnotation);
    assert.strictEqual(returnType.types.length, 2);
    assert.strictEqual(
      returnType.types[0].type,
      NodeType.UnboxedTupleTypeAnnotation,
    );
    assert.strictEqual(
      returnType.types[1].type,
      NodeType.UnboxedTupleTypeAnnotation,
    );
  });

  test('parses nested types in unboxed tuple', () => {
    const parser = new Parser('let f = (): (Box<i32>, array<i32>) => 0;');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnType = func.returnType;
    assert.strictEqual(returnType.type, NodeType.UnboxedTupleTypeAnnotation);
    assert.strictEqual(returnType.elementTypes.length, 2);
    // Generic types have typeArguments property
    assert.strictEqual(returnType.elementTypes[0].name, 'Box');
    assert.ok(returnType.elementTypes[0].typeArguments);
    assert.strictEqual(returnType.elementTypes[1].name, 'array');
    assert.ok(returnType.elementTypes[1].typeArguments);
  });
});

suite('Parser: Unboxed Tuple Destructuring', () => {
  test('parses basic unboxed tuple destructuring', () => {
    const parser = new Parser('let (a, b) = getTuple();');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    assert.strictEqual(decl.pattern.type, NodeType.UnboxedTuplePattern);
    assert.strictEqual(decl.pattern.elements.length, 2);
    assert.strictEqual(decl.pattern.elements[0].type, NodeType.Identifier);
    assert.strictEqual(decl.pattern.elements[0].name, 'a');
    assert.strictEqual(decl.pattern.elements[1].type, NodeType.Identifier);
    assert.strictEqual(decl.pattern.elements[1].name, 'b');
  });

  test('parses unboxed tuple destructuring with three elements', () => {
    const parser = new Parser('let (x, y, z) = getTriple();');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.pattern.type, NodeType.UnboxedTuplePattern);
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

  test('parses unboxed tuple pattern with nested patterns', () => {
    const parser = new Parser('let (a, (b, c)) = nested();');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.pattern.type, NodeType.UnboxedTuplePattern);
    assert.strictEqual(decl.pattern.elements.length, 2);
    assert.strictEqual(decl.pattern.elements[0].name, 'a');
    assert.strictEqual(
      decl.pattern.elements[1].type,
      NodeType.UnboxedTuplePattern,
    );
    assert.strictEqual(decl.pattern.elements[1].elements.length, 2);
  });

  test('parses unboxed tuple pattern in match expression', () => {
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
    // First case pattern should be unboxed tuple
    assert.strictEqual(
      match.cases[0].pattern.type,
      NodeType.UnboxedTuplePattern,
    );
    assert.strictEqual(match.cases[0].pattern.elements.length, 2);
  });
});

suite('Parser: Unboxed Tuple Expressions', () => {
  test('parses unboxed tuple expression as function body (double parens)', () => {
    // Double parens required: outer parens are grouping, inner parens are the tuple
    const parser = new Parser(
      'let f = (a: i32, b: i32): (i32, i32) => ((a, b));',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.type, NodeType.FunctionExpression);
    assert.strictEqual(func.body.type, NodeType.UnboxedTupleLiteral);
    assert.strictEqual(func.body.elements.length, 2);
    assert.strictEqual(func.body.elements[0].name, 'a');
    assert.strictEqual(func.body.elements[1].name, 'b');
  });

  test('parses unboxed tuple expression with expressions (double parens)', () => {
    const parser = new Parser(
      'let f = (a: i32, b: i32): (i32, i32) => ((a / b, a % b));',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const tuple = func.body;
    assert.strictEqual(tuple.type, NodeType.UnboxedTupleLiteral);
    assert.strictEqual(tuple.elements.length, 2);
    assert.strictEqual(tuple.elements[0].type, NodeType.BinaryExpression);
    assert.strictEqual(tuple.elements[1].type, NodeType.BinaryExpression);
  });

  test('parses unboxed tuple with three elements (double parens)', () => {
    const parser = new Parser('let f = (): (i32, i32, i32) => ((1, 2, 3));');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const tuple = decl.init.body;
    assert.strictEqual(tuple.type, NodeType.UnboxedTupleLiteral);
    assert.strictEqual(tuple.elements.length, 3);
  });

  test('parses single element in parens as grouping (not tuple)', () => {
    const parser = new Parser('let x = (1 + 2);');
    const module = parser.parse();
    const decl = module.body[0] as any;
    // Single element is just grouping, returns the inner expression
    assert.strictEqual(decl.init.type, NodeType.BinaryExpression);
  });

  test('parses nested unboxed tuples (double parens)', () => {
    const parser = new Parser(
      'let f = (): ((i32, i32), i32) => (((1, 2), 3));',
    );
    const module = parser.parse();
    const decl = module.body[0] as any;
    const tuple = decl.init.body;
    assert.strictEqual(tuple.type, NodeType.UnboxedTupleLiteral);
    assert.strictEqual(tuple.elements.length, 2);
    assert.strictEqual(tuple.elements[0].type, NodeType.UnboxedTupleLiteral);
    assert.strictEqual(tuple.elements[1].type, NodeType.NumberLiteral);
  });

  test('parses unboxed tuple in return statement', () => {
    const parser = new Parser(`
      let f = (): (i32, i32) => {
        return (1, 2);
      };
    `);
    const module = parser.parse();
    const decl = module.body[0] as any;
    const func = decl.init;
    const returnStmt = func.body.body[0];
    assert.strictEqual(returnStmt.type, NodeType.ReturnStatement);
    assert.strictEqual(returnStmt.argument.type, NodeType.UnboxedTupleLiteral);
    assert.strictEqual(returnStmt.argument.elements.length, 2);
  });
});
