import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Final Modifier', () => {
  test('should allow extending non-final class', () => {
    const input = `
      class Base {}
      class Derived extends Base {}
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should prevent extending final class', () => {
    const input = `
      final class Base {}
      class Derived extends Base {}
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Cannot extend final class 'Base'/);
  });

  test('should allow overriding non-final method', () => {
    const input = `
      class Base {
        foo(): void {}
      }
      class Derived extends Base {
        foo(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should prevent overriding final method', () => {
    const input = `
      class Base {
        final foo(): void {}
      }
      class Derived extends Base {
        foo(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Cannot override final method 'foo'/);
  });

  test('should prevent overriding final accessor', () => {
    const input = `
      class Base {
        final prop: i32 { get { return 0; } }
      }
      class Derived extends Base {
        prop: i32 { get { return 1; } }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.ok(errors.length >= 1);
    assert.match(
      errors.map((e) => e.message).join('\n'),
      /Cannot override final method 'get_prop'/,
    );
  });
});
