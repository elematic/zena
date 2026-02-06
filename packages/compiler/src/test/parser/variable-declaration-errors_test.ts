import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';

suite('Parser - Variable Declaration Error Messages', () => {
  suite('const keyword', () => {
    test('should suggest let for const', () => {
      const parser = new Parser('const foo = 1;');
      assert.throws(() => parser.parse(), /const.*is not a keyword.*Use 'let'/);
    });

    test('should suggest let for const with destructuring', () => {
      const parser = new Parser('const {x, y} = point;');
      assert.throws(() => parser.parse(), /const.*is not a keyword.*Use 'let'/);
    });
  });

  suite('misspelled keywords', () => {
    test('should suggest let for lett', () => {
      const parser = new Parser('lett foo = 1;');
      assert.throws(() => parser.parse(), /Unknown keyword 'lett'.*'let'/);
    });

    test('should suggest let for leet', () => {
      const parser = new Parser('leet foo = 1;');
      assert.throws(() => parser.parse(), /Unknown keyword 'leet'.*'let'/);
    });

    test('should suggest var for vat', () => {
      const parser = new Parser('vat foo = 1;');
      assert.throws(() => parser.parse(), /Unknown keyword 'vat'.*'var'/);
    });

    test('should suggest var for varr', () => {
      const parser = new Parser('varr foo = 1;');
      assert.throws(() => parser.parse(), /Unknown keyword 'varr'.*'var'/);
    });

    test('should suggest var for va', () => {
      const parser = new Parser('va foo = 1;');
      assert.throws(() => parser.parse(), /Unknown keyword 'va'.*'var'/);
    });
  });

  suite('wrong case keywords', () => {
    test('should suggest let for Let', () => {
      const parser = new Parser('Let foo = 1;');
      assert.throws(() => parser.parse(), /Keywords are case-sensitive.*'let'/);
    });

    test('should suggest let for LET', () => {
      const parser = new Parser('LET foo = 1;');
      assert.throws(() => parser.parse(), /Keywords are case-sensitive.*'let'/);
    });

    test('should suggest var for Var', () => {
      const parser = new Parser('Var foo = 1;');
      assert.throws(() => parser.parse(), /Keywords are case-sensitive.*'var'/);
    });

    test('should suggest var for VAR', () => {
      const parser = new Parser('VAR foo = 1;');
      assert.throws(() => parser.parse(), /Keywords are case-sensitive.*'var'/);
    });

    test('should suggest class for Class', () => {
      const parser = new Parser('Class Foo {}');
      assert.throws(
        () => parser.parse(),
        /Keywords are case-sensitive.*'class'/,
      );
    });

    test('should suggest symbol for Symbol', () => {
      const parser = new Parser('Symbol foo;');
      assert.throws(
        () => parser.parse(),
        /Keywords are case-sensitive.*'symbol'/,
      );
    });
  });

  suite('should not produce false positives', () => {
    test('should allow identifier expression followed by semicolon', () => {
      const parser = new Parser('foo;');
      const ast = parser.parse();
      assert.strictEqual(ast.body.length, 1);
    });

    test('should allow function call', () => {
      const parser = new Parser('foo();');
      const ast = parser.parse();
      assert.strictEqual(ast.body.length, 1);
    });

    test('should allow addition expression', () => {
      const parser = new Parser('foo + bar;');
      const ast = parser.parse();
      assert.strictEqual(ast.body.length, 1);
    });

    test('should parse valid let declaration', () => {
      const parser = new Parser('let x = 1;');
      const ast = parser.parse();
      assert.strictEqual(ast.body.length, 1);
    });

    test('should parse valid var declaration', () => {
      const parser = new Parser('var x = 1;');
      const ast = parser.parse();
      assert.strictEqual(ast.body.length, 1);
    });
  });
});
