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
    const checker = TypeChecker.forProgram(ast);
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
    const checker = TypeChecker.forProgram(ast);
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
    const checker = TypeChecker.forProgram(ast);
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
    const checker = TypeChecker.forProgram(ast);
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
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 2);
    assert.match(errors[0].message, /Getter for 'y' is missing/);
    assert.match(errors[1].message, /Setter for 'y' is missing/);
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
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 2);
    assert.match(
      errors[0].message,
      /Getter for 'x' is type .* but expected .*/,
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
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should check valid interface accessor implementation', () => {
    const input = `
      interface Container {
        value: i32 { get; set; }
      }
      class Box implements Container {
        _value: i32 = 0;
        value: i32 {
          get { return this._value; }
          set(v) { this._value = v; }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should detect missing getter implementation', () => {
    const input = `
      interface Container {
        value: i32 { get; }
      }
      class Box implements Container {
        value: i32 {
          set(v) {}
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Getter for 'value' is missing/);
  });

  test('should detect missing setter implementation', () => {
    const input = `
      interface Container {
        value: i32 { set; }
      }
      class Box implements Container {
        value: i32 {
          get { return 0; }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Setter for 'value' is missing/);
  });

  test('should detect incorrect getter return type', () => {
    const input = `
      interface Container {
        value: i32 { get; }
      }
      class Box implements Container {
        value: f32 {
          get { return 0.0; }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Getter for 'value' is type .* but expected .*/,
    );
  });

  test('should detect incorrect setter parameter type', () => {
    const input = `
      interface Container {
        value: i32 { set; }
      }
      class Box implements Container {
        value: f32 {
          set(v) {}
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0].message,
      /Setter for 'value' is type .* but expected .*/,
    );
  });

  test('should satisfy interface accessor with field', () => {
    const input = `
      interface Container {
        value: i32 { get; set; }
      }
      class Box implements Container {
        value: i32 = 0;
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should satisfy interface field with accessor', () => {
    const input = `
      interface Container {
        value: i32;
      }
      class Box implements Container {
        _val: i32 = 0;
        value: i32 {
          get { return this._val; }
          set(v) { this._val = v; }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = TypeChecker.forProgram(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });
});

// TODO (justinfagnani): Add more tests: generic interfaces, interface
// inheritance, incompatible multiple interfaces, etc.
