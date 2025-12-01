import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';

suite('Parser - Optional Parameters', () => {
  test('should parse optional parameter without default', () => {
    const parser = new Parser('let f = (x?: i32) => {};');
    const ast = parser.parse();
    const decl = ast.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.params.length, 1);
    assert.strictEqual(func.params[0].name.name, 'x');
    assert.strictEqual(func.params[0].optional, true);
    assert.strictEqual(func.params[0].initializer, undefined);
  });

  test('should parse optional parameter with default', () => {
    const parser = new Parser('let f = (x: i32 = 10) => {};');
    const ast = parser.parse();
    const decl = ast.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.params.length, 1);
    assert.strictEqual(func.params[0].name.name, 'x');
    assert.strictEqual(func.params[0].optional, true);
    assert.notStrictEqual(func.params[0].initializer, undefined);
  });

  test('should parse optional parameter with ? and default', () => {
    // This syntax is technically allowed by parser but redundant?
    // Parser logic: if ? set optional=true. if = set optional=true.
    const parser = new Parser('let f = (x?: i32 = 10) => {};');
    const ast = parser.parse();
    const decl = ast.body[0] as any;
    const func = decl.init;
    assert.strictEqual(func.params.length, 1);
    assert.strictEqual(func.params[0].optional, true);
    assert.notStrictEqual(func.params[0].initializer, undefined);
  });

  test('should fail if required parameter follows optional', () => {
    const parser = new Parser('let f = (x?: i32, y: i32) => {};');
    assert.throws(
      () => parser.parse(),
      /Required parameter cannot follow an optional parameter/,
    );
  });

  test('should parse optional parameters in methods', () => {
    const parser = new Parser(`
      class C {
        m(x?: i32) {}
      }
    `);
    const ast = parser.parse();
    const classDecl = ast.body[0] as any;
    const method = classDecl.body[0];
    assert.strictEqual(method.params[0].optional, true);
  });

  test('should parse optional parameters in interfaces', () => {
    const parser = new Parser(`
      interface I {
        m(x?: i32);
      }
    `);
    const ast = parser.parse();
    const ifaceDecl = ast.body[0] as any;
    const method = ifaceDecl.body[0];
    assert.strictEqual(method.params[0].optional, true);
  });

  test('should parse optional parameters in declare function', () => {
    const parser = new Parser(`
      @external("env", "f")
      declare function f(x?: i32): void;
    `);
    const ast = parser.parse();
    const decl = ast.body[0] as any; // Decorated statement returns DeclareFunction directly? No, parseDecoratedStatement returns DeclareFunction.
    assert.strictEqual(decl.params[0].optional, true);
  });
});
