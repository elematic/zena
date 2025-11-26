import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

suite('TypeChecker - Interfaces', () => {
  test('should check valid interface implementation', () => {
    const input = `
      interface Runnable {
        run(): void;
      }
      class Task implements Runnable {
        run(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should detect missing method implementation', () => {
    const input = `
      interface Runnable {
        run(): void;
      }
      class Task implements Runnable {
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Method 'run' is missing/);
  });

  test('should detect incorrect method signature', () => {
    const input = `
      interface Runnable {
        run(): void;
      }
      class Task implements Runnable {
        run(x: i32): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Method 'run' is type .* but expected .*/);
  });

  test('should check valid interface with fields', () => {
    const input = `
      interface Point {
        x: i32;
        y: i32;
      }
      class Point2D implements Point {
        x: i32 = 0;
        y: i32 = 0;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should detect missing field implementation', () => {
    const input = `
      interface Point {
        x: i32;
        y: i32;
      }
      class Point2D implements Point {
        x: i32 = 0;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Property 'y' is missing/);
  });

  test('should detect incorrect field type', () => {
    const input = `
      interface Point {
        x: i32;
      }
      class Point2D implements Point {
        x: f32 = 0.0;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Property 'x' is type 'f32' but expected 'i32'/,
    );
  });

  test('should check multiple interfaces', () => {
    const input = `
      interface Runnable {
        run(): void;
      }
      interface Stoppable {
        stop(): void;
      }
      class Task implements Runnable, Stoppable {
        run(): void {}
        stop(): void {}
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });
});

// TODO (justinfagnani): Add more tests: generic interfaces, interface
// inheritance, incompatible multiple interfaces, etc.
