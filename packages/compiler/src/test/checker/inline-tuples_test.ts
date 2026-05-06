import {suite, test} from 'node:test';
import assert from 'node:assert';
import {Parser} from '../../lib/parser.js';
import {TypeChecker} from '../../lib/checker/index.js';

function checkSub(source: string) {
  const parser = new Parser(source);
  const ast = parser.parse();
  const checker = TypeChecker.forModule(ast);
  return checker.check();
}

suite('Checker: Inline Tuple Validation', () => {
  suite('Valid positions', () => {
    test('allows inline tuple as function return type', () => {
      const source = `
        export let main = (): i32 => {
          let f = (): inline (i32, i32) => {
            return (1, 2);
          };
          return 0;
        };
      `;
      const errors = checkSub(source);
      assert.strictEqual(errors.length, 0);
    });
  });

  suite('Invalid positions', () => {
    test('rejects inline tuple in variable type annotation', () => {
      const source = `
        export let main = (): i32 => {
          let x: inline (i32, i32) = (1, 2);
          return 0;
        };
      `;
      const errors = checkSub(source);
      assert.ok(errors.length > 0, 'Expected errors');
      assert.ok(
        errors.some((e) => /variable types/.test(e.message)),
        'Expected error about variable types',
      );
    });

    test('rejects inline tuple in parameter type', () => {
      const source = `
        export let main = (): i32 => {
          let f = (x: inline (i32, i32)): i32 => 0;
          return 0;
        };
      `;
      const errors = checkSub(source);
      assert.ok(errors.length > 0, 'Expected errors');
      assert.ok(
        errors.some((e) => /parameter types/.test(e.message)),
        'Expected error about parameter types',
      );
    });

    test('rejects inline tuple in class field type', () => {
      const source = `
        class Point {
          coords: inline (i32, i32);
          new() {}
        }
        export let main = (): i32 => 0;
      `;
      const errors = checkSub(source);
      assert.ok(errors.length > 0, 'Expected errors');
      assert.ok(
        errors.some((e) => /field types/.test(e.message)),
        'Expected error about field types',
      );
    });

    test('rejects inline tuple in interface field type', () => {
      const source = `
        interface HasCoords {
          coords: inline (i32, i32);
        }
        export let main = (): i32 => 0;
      `;
      const errors = checkSub(source);
      assert.ok(errors.length > 0, 'Expected errors');
      assert.ok(
        errors.some((e) => /field types/.test(e.message)),
        'Expected error about field types',
      );
    });

    test('rejects inline tuple in accessor type', () => {
      const source = `
        class Point {
          #x: i32;
          #y: i32;
          coords: inline (i32, i32) {
            get {
              return (this.#x, this.#y);
            }
          }
          new() {}
        }
        export let main = (): i32 => 0;
      `;
      const errors = checkSub(source);
      assert.ok(errors.length > 0, 'Expected errors');
      assert.ok(
        errors.some((e) => /accessor types/.test(e.message)),
        'Expected error about accessor types',
      );
    });

    test('rejects inline tuple nested in array type', () => {
      const source = `
        export let main = (): i32 => {
          let arr: array<inline (i32, i32)> = [];
          return 0;
        };
      `;
      const errors = checkSub(source);
      assert.ok(errors.length > 0, 'Expected errors');
      assert.ok(
        errors.some((e) => /variable types/.test(e.message)),
        'Expected error about variable types',
      );
    });

    test('rejects inline tuple as generic type argument', () => {
      const source = `
        class Box<T> {
          value: T;
          new(this.value);
        }
        export let main = (): i32 => {
          let b: Box<inline (i32, i32)> = new Box((1, 2));
          return 0;
        };
      `;
      const errors = checkSub(source);
      assert.ok(errors.length > 0, 'Expected errors');
      assert.ok(
        errors.some((e) => /type arguments/.test(e.message)),
        'Expected error about type arguments',
      );
    });
  });
});
