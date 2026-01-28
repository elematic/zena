import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker: Template Literals', () => {
  test('should check simple template literal', () => {
    const input = 'let x = `hello world`;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should check template literal with substitution', () => {
    const input = `
      let name = "world";
      let greeting = \`hello \${name}\`;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should detect undefined variable in template substitution', () => {
    const input = 'let x = `hello ${unknownVar}`;';
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Variable 'unknownVar' not found/);
  });

  test('should check template literal with expression', () => {
    const input = `
      let a = 1;
      let b = 2;
      let result = \`sum is \${a + b}\`;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should check tagged template with valid tag function', () => {
    // Use i32 types since String type may not be available in base checker
    const input = `
      let tag = (strings: i32, values: i32): i32 => 0;
      let x = tag\`hello \${42}\`;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });

  test('should reject non-function tag', () => {
    const input = `
      let tag = 42;
      let x = tag\`hello\`;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /must be a function/);
  });

  test('should reject tag function with insufficient parameters', () => {
    const input = `
      let tag = (x: i32): i32 => 0;
      let x = tag\`hello\`;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /at least 2 parameters/);
  });

  test('should check nested template literals', () => {
    const input = `
      let inner = \`inner\`;
      let outer = \`outer \${inner}\`;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forModule(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 0);
  });
});
