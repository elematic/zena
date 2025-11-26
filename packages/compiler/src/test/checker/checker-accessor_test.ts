import assert from 'node:assert';
import {suite, test} from 'node:test';
import {TypeChecker} from '../../lib/checker/index.js';
import {Parser} from '../../lib/parser.js';

suite('TypeChecker - Accessors', () => {
  test('should check valid accessor declaration', () => {
    const input = `
      class Box {
        #value: i32;
        
        #new(v: i32) {
          this.#value = v;
        }

        value: i32 {
          get {
            return this.#value;
          }
          set(v) {
            this.#value = v;
          }
        }
      }
      let b = new Box(10);
      let v = b.value;
      b.value = 20;
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.deepStrictEqual(errors, []);
  });

  test('should detect getter return type mismatch', () => {
    const input = `
      class Box {
        value: i32 {
          get {
            return "hello"; // Error: expected i32
          }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });

  test('should detect setter parameter usage mismatch', () => {
    const input = `
      class Box {
        #value: i32;
        value: i32 {
          set(v) {
             let s: string = v; // Error: v is i32
          }
        }
      }
    `;
    const parser = new Parser(input);
    const ast = parser.parse();
    const checker = new TypeChecker(ast);
    const errors = checker.check();

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /Type mismatch/);
  });
});
