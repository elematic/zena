import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {NodeType} from '../../lib/ast.js';

suite('Parser: Records and Tuples', () => {
  test('parses record literal', () => {
    const parser = new Parser('let r = { x: 1, y: 2 };');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.type, NodeType.VariableDeclaration);
    const init = decl.init;
    assert.strictEqual(init.type, NodeType.RecordLiteral);
    assert.strictEqual(init.properties.length, 2);
    assert.strictEqual(init.properties[0].name.name, 'x');
    assert.strictEqual(init.properties[0].value.value, 1);
    assert.strictEqual(init.properties[1].name.name, 'y');
    assert.strictEqual(init.properties[1].value.value, 2);
  });

  test('parses tuple literal', () => {
    const parser = new Parser('let t = [1, "hello"];');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const init = decl.init;
    assert.strictEqual(init.type, NodeType.TupleLiteral);
    assert.strictEqual(init.elements.length, 2);
    assert.strictEqual(init.elements[0].value, 1);
    assert.strictEqual(init.elements[1].value, 'hello');
  });

  test('parses record type', () => {
    const parser = new Parser('let r: { x: i32, y: i32 } = { x: 1, y: 2 };');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.RecordTypeAnnotation);
    assert.strictEqual(type.properties.length, 2);
    assert.strictEqual(type.properties[0].name.name, 'x');
    assert.strictEqual(type.properties[0].typeAnnotation.name, 'i32');
  });

  test('parses tuple type', () => {
    const parser = new Parser('let t: [i32, string] = [1, "s"];');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.TupleTypeAnnotation);
    assert.strictEqual(type.elementTypes.length, 2);
    assert.strictEqual(type.elementTypes[0].name, 'i32');
    assert.strictEqual(type.elementTypes[1].name, 'string');
  });

  test('parses nested records and tuples', () => {
    const parser = new Parser('let n = { a: [1], b: { c: 2 } };');
    const module = parser.parse();
    const init = (module.body[0] as any).init;
    assert.strictEqual(init.type, NodeType.RecordLiteral);
    assert.strictEqual(init.properties[0].value.type, NodeType.TupleLiteral);
    assert.strictEqual(init.properties[1].value.type, NodeType.RecordLiteral);
  });

  test('parses empty record and tuple', () => {
    const parser = new Parser('let e = { }; let t = [];');
    const module = parser.parse();
    const r = (module.body[0] as any).init;
    assert.strictEqual(r.type, NodeType.RecordLiteral);
    assert.strictEqual(r.properties.length, 0);

    const t = (module.body[1] as any).init;
    assert.strictEqual(t.type, NodeType.TupleLiteral);
    assert.strictEqual(t.elements.length, 0);
  });

  test('parses record shorthand', () => {
    const parser = new Parser('let r = { x, y };');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const init = decl.init;
    assert.strictEqual(init.type, NodeType.RecordLiteral);
    assert.strictEqual(init.properties.length, 2);

    assert.strictEqual(init.properties[0].name.name, 'x');
    assert.strictEqual(init.properties[0].value.type, NodeType.Identifier);
    assert.strictEqual(init.properties[0].value.name, 'x');

    assert.strictEqual(init.properties[1].name.name, 'y');
    assert.strictEqual(init.properties[1].value.type, NodeType.Identifier);
    assert.strictEqual(init.properties[1].value.name, 'y');
  });

  test('parses mixed shorthand and full syntax', () => {
    const parser = new Parser('let r = { x, y: 2, z };');
    const module = parser.parse();
    const init = (module.body[0] as any).init;

    assert.strictEqual(init.properties[0].name.name, 'x');
    assert.strictEqual(init.properties[0].value.name, 'x');

    assert.strictEqual(init.properties[1].name.name, 'y');
    assert.strictEqual(init.properties[1].value.value, 2);

    assert.strictEqual(init.properties[2].name.name, 'z');
    assert.strictEqual(init.properties[2].value.name, 'z');
  });

  test('parses record type with optional field', () => {
    const parser = new Parser('let r: { x: i32, y?: i32 } = { x: 1 };');
    const module = parser.parse();
    const decl = module.body[0] as any;
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.RecordTypeAnnotation);
    assert.strictEqual(type.properties.length, 2);

    // x is required
    assert.strictEqual(type.properties[0].name.name, 'x');
    assert.strictEqual(type.properties[0].optional, undefined);

    // y is optional
    assert.strictEqual(type.properties[1].name.name, 'y');
    assert.strictEqual(type.properties[1].optional, true);
  });

  test('parses record type with all optional fields', () => {
    const parser = new Parser('let opts: { timeout?: i32, retries?: i32 } = {};');
    const module = parser.parse();
    const type = (module.body[0] as any).typeAnnotation;
    assert.strictEqual(type.properties.length, 2);
    assert.strictEqual(type.properties[0].name.name, 'timeout');
    assert.strictEqual(type.properties[0].optional, true);
    assert.strictEqual(type.properties[1].name.name, 'retries');
    assert.strictEqual(type.properties[1].optional, true);
  });

  test('parses type alias with optional record fields', () => {
    const parser = new Parser('type Opts = { url: string, timeout?: i32 };');
    const module = parser.parse();
    const decl = module.body[0] as any;
    assert.strictEqual(decl.type, NodeType.TypeAliasDeclaration);
    const type = decl.typeAnnotation;
    assert.strictEqual(type.type, NodeType.RecordTypeAnnotation);
    assert.strictEqual(type.properties[0].name.name, 'url');
    assert.strictEqual(type.properties[0].optional, undefined);
    assert.strictEqual(type.properties[1].name.name, 'timeout');
    assert.strictEqual(type.properties[1].optional, true);
  });
});
