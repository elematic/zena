import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';
import {TypeKind, type LiteralType} from '../../lib/types.js';

suite('Checker: Literal Types', () => {
  test('should infer string literal type', () => {
    const input = "let x: 'hello' = 'hello';";
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
    const decl = ast.body[0];
    if (decl.type === 'VariableDeclaration') {
      const type = decl.inferredType;
      assert.ok(type);
      assert.strictEqual(type!.kind, TypeKind.Literal);
      if (type!.kind === TypeKind.Literal) {
        assert.strictEqual((type as LiteralType).value, 'hello');
      }
    }
  });

  test('should infer number literal type', () => {
    const input = 'let x: 42 = 42;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
    const decl = ast.body[0];
    if (decl.type === 'VariableDeclaration') {
      const type = decl.inferredType;
      assert.ok(type);
      assert.strictEqual(type!.kind, TypeKind.Literal);
      if (type!.kind === TypeKind.Literal) {
        assert.strictEqual((type as LiteralType).value, 42);
      }
    }
  });

  test('should infer boolean literal type', () => {
    const input = 'let x: true = true;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
    const decl = ast.body[0];
    if (decl.type === 'VariableDeclaration') {
      const type = decl.inferredType;
      assert.ok(type);
      assert.strictEqual(type!.kind, TypeKind.Literal);
      if (type!.kind === TypeKind.Literal) {
        assert.strictEqual((type as LiteralType).value, true);
      }
    }
  });

  test('should allow string literal union type', () => {
    const input = `
      type Mode = 'replace' | 'append';
      let mode: Mode = 'replace';
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow number literal union type', () => {
    const input = `
      type Level = 1 | 2 | 3;
      let level: Level = 2;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should allow boolean literal union type', () => {
    const input = `
      type Flag = true | false;
      let flag: Flag = true;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should assign literal to its base type - string', () => {
    const input = `
      let x: 'hello' = 'hello';
      let y: string = x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should assign literal to its base type - number', () => {
    const input = `
      let x: 42 = 42;
      let y: i32 = x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should assign literal to its base type - boolean', () => {
    const input = `
      let x: true = true;
      let y: boolean = x;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should reject mismatched string literal', () => {
    const input = `
      let x: 'hello' = 'world';
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length > 0, true);
  });

  test('should reject mismatched number literal', () => {
    const input = `
      let x: 42 = 43;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length > 0, true);
  });

  test('should reject mismatched boolean literal', () => {
    const input = `
      let x: true = false;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length > 0, true);
  });

  test('should handle union of string literals in function parameters', () => {
    const input = `
      let setMode = (mode: 'replace' | 'append') => {
        let x = mode;
      };
      setMode('replace');
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should reject invalid value for string literal union', () => {
    const input = `
      let setMode = (mode: 'replace' | 'append') => {
        let x = mode;
      };
      setMode('invalid');
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length > 0, true);
  });

  test('should allow exact match in union', () => {
    const input = `
      type Mode = 'replace' | 'append' | 'insert';
      let x: Mode = 'append';
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });
});
