import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {
  NodeType,
  type VariableDeclaration,
  type RecordPattern,
  type TuplePattern,
  type AssignmentPattern,
} from '../../lib/ast.js';

suite('Parser - Destructuring', () => {
  test('should parse record destructuring', () => {
    const input = 'let { x, y } = p;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    assert.strictEqual(decl.pattern.type, NodeType.RecordPattern);

    const pattern = decl.pattern as RecordPattern;
    assert.strictEqual(pattern.properties.length, 2);
    assert.strictEqual(pattern.properties[0].name.name, 'x');
    assert.strictEqual(pattern.properties[0].value.type, NodeType.Identifier);
    assert.strictEqual((pattern.properties[0].value as any).name, 'x');

    assert.strictEqual(pattern.properties[1].name.name, 'y');
  });

  test('should parse record destructuring with renaming', () => {
    const input = 'let { x as x1 } = p;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const pattern = decl.pattern as RecordPattern;

    assert.strictEqual(pattern.properties[0].name.name, 'x');
    assert.strictEqual(pattern.properties[0].value.type, NodeType.Identifier);
    assert.strictEqual((pattern.properties[0].value as any).name, 'x1');
  });

  test('should parse record destructuring with nesting', () => {
    const input = 'let { x: { y } } = p;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const pattern = decl.pattern as RecordPattern;

    assert.strictEqual(pattern.properties[0].name.name, 'x');
    assert.strictEqual(
      pattern.properties[0].value.type,
      NodeType.RecordPattern,
    );

    const inner = pattern.properties[0].value as RecordPattern;
    assert.strictEqual(inner.properties[0].name.name, 'y');
  });

  test('should parse record destructuring with defaults', () => {
    const input = 'let { x = 1 } = p;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const pattern = decl.pattern as RecordPattern;

    assert.strictEqual(pattern.properties[0].name.name, 'x');
    assert.strictEqual(
      pattern.properties[0].value.type,
      NodeType.AssignmentPattern,
    );

    const assign = pattern.properties[0].value as AssignmentPattern;
    assert.strictEqual(assign.left.type, NodeType.Identifier);
    assert.strictEqual((assign.left as any).name, 'x');
    assert.strictEqual(assign.right.type, NodeType.NumberLiteral);
  });

  test('should parse tuple destructuring', () => {
    const input = 'let [x, y] = p;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    assert.strictEqual(decl.pattern.type, NodeType.TuplePattern);

    const pattern = decl.pattern as TuplePattern;
    assert.strictEqual(pattern.elements.length, 2);
    assert.strictEqual(pattern.elements[0]!.type, NodeType.Identifier);
    assert.strictEqual((pattern.elements[0] as any).name, 'x');
  });

  test('should parse tuple destructuring with defaults', () => {
    const input = 'let [x = 1] = p;';
    const parser = new Parser(input);
    const ast = parser.parse();

    const decl = ast.body[0] as VariableDeclaration;
    const pattern = decl.pattern as TuplePattern;

    assert.strictEqual(pattern.elements[0]!.type, NodeType.AssignmentPattern);
    const assign = pattern.elements[0] as AssignmentPattern;
    assert.strictEqual(assign.left.type, NodeType.Identifier);
    assert.strictEqual((assign.left as any).name, 'x');
  });
});
