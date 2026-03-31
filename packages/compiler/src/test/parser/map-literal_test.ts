import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Map Literals', () => {
  test('parses map literal with string keys', () => {
    const parser = new Parser('let m = {"a" => 1, "b" => 2};');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    const init = decl.init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries.length, 2);

    assert.strictEqual(init.entries[0].type, NodeType.MapEntry);
    assert.strictEqual(init.entries[0].key.value, 'a');
    assert.strictEqual(init.entries[0].value.raw, '1');

    assert.strictEqual(init.entries[1].key.value, 'b');
    assert.strictEqual(init.entries[1].value.raw, '2');
  });

  test('parses map literal with number keys', () => {
    const parser = new Parser('let m = {1 => "one", 2 => "two"};');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries.length, 2);

    assert.strictEqual(init.entries[0].key.raw, '1');
    assert.strictEqual(init.entries[0].value.value, 'one');
  });

  test('parses map literal with single entry', () => {
    const parser = new Parser('let m = {"key" => "value"};');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries.length, 1);
  });

  test('parses map literal with trailing comma', () => {
    const parser = new Parser('let m = {"a" => 1, "b" => 2,};');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries.length, 2);
  });

  test('parses map literal with identifier keys', () => {
    const parser = new Parser('let m = {key => value};');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries.length, 1);
    assert.strictEqual(init.entries[0].key.type, NodeType.Identifier);
    assert.strictEqual(init.entries[0].key.name, 'key');
    assert.strictEqual(init.entries[0].value.type, NodeType.Identifier);
    assert.strictEqual(init.entries[0].value.name, 'value');
  });

  test('parses map literal with expression keys', () => {
    const parser = new Parser('let m = {1 + 1 => "two", 2 * 2 => "four"};');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries.length, 2);
    assert.strictEqual(init.entries[0].key.type, NodeType.BinaryExpression);
    assert.strictEqual(init.entries[1].key.type, NodeType.BinaryExpression);
  });

  test('parses nested map literal', () => {
    const parser = new Parser('let m = {"outer" => {"inner" => 42}};');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries[0].value.type, NodeType.MapLiteral);
  });

  test('distinguishes map from record - map uses =>', () => {
    const parser = new Parser('let m = {"a" => 1}; let r = {a: 1};');
    const module = parser.parse();

    const mapInit = (module.body[0] as any).init;
    assert.strictEqual(mapInit.type, NodeType.MapLiteral);

    const recordInit = (module.body[1] as any).init;
    assert.strictEqual(recordInit.type, NodeType.RecordLiteral);
  });

  test('empty braces parse as empty record', () => {
    const parser = new Parser('let r = {};');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.RecordLiteral);
    assert.strictEqual(init.properties.length, 0);
  });

  test('parses multiline map literal', () => {
    const parser = new Parser(`let m = {
      "name" => "Alice",
      "age" => 30,
      "city" => "NYC",
    };`);
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.MapLiteral);
    assert.strictEqual(init.entries.length, 3);
  });
});
