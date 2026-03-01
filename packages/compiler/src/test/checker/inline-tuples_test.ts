import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from '../codegen/utils.js';

suite('Checker: Inline Tuple Validation', () => {
  suite('Valid positions', () => {
    test('allows inline tuple as function return type', async () => {
      // For now, just check that this compiles without errors
      // Full codegen support for multi-value returns is pending
      const source = `
        export let main = (): i32 => {
          let f = (): inline (i32, i32) => {
            return (1, 2);
          };
          return 0;
        };
      `;
      // This will fail at codegen (not implemented yet) but should pass checker
      try {
        await compileAndRun(source, 'main');
      } catch (e: any) {
        // Expected to fail at codegen, but not at checker
        assert.ok(
          !e.message.includes('Inline tuple types can only appear'),
          'Should not fail with inline tuple position error',
        );
      }
    });
  });

  suite('Invalid positions', () => {
    test('rejects inline tuple in variable type annotation', async () => {
      const source = `
        export let main = (): i32 => {
          let x: inline (i32, i32) = (1, 2);
          return 0;
        };
      `;
      try {
        await compileAndRun(source, 'main');
        assert.fail('Should have failed compilation');
      } catch (e: any) {
        assert.match(e.message, /variable types/);
      }
    });

    test('rejects inline tuple in parameter type', async () => {
      const source = `
        export let main = (): i32 => {
          let f = (x: inline (i32, i32)): i32 => 0;
          return 0;
        };
      `;
      try {
        await compileAndRun(source, 'main');
        assert.fail('Should have failed compilation');
      } catch (e: any) {
        assert.match(e.message, /parameter types/);
      }
    });

    test('rejects inline tuple in class field type', async () => {
      const source = `
        class Point {
          coords: inline (i32, i32);
          #new() {
            this.coords = (0, 0);
          }
        }
        export let main = (): i32 => 0;
      `;
      try {
        await compileAndRun(source, 'main');
        assert.fail('Should have failed compilation');
      } catch (e: any) {
        assert.match(e.message, /field types/);
      }
    });

    test('rejects inline tuple in interface field type', async () => {
      const source = `
        interface HasCoords {
          coords: inline (i32, i32);
        }
        export let main = (): i32 => 0;
      `;
      try {
        await compileAndRun(source, 'main');
        assert.fail('Should have failed compilation');
      } catch (e: any) {
        assert.match(e.message, /field types/);
      }
    });

    test('rejects inline tuple in accessor type', async () => {
      const source = `
        class Point {
          #x: i32;
          #y: i32;
          coords: inline (i32, i32) {
            get {
              return (this.#x, this.#y);
            }
          }
          #new() {
            this.#x = 0;
            this.#y = 0;
          }
        }
        export let main = (): i32 => 0;
      `;
      try {
        await compileAndRun(source, 'main');
        assert.fail('Should have failed compilation');
      } catch (e: any) {
        assert.match(e.message, /accessor types/);
      }
    });

    test('rejects inline tuple nested in array type', async () => {
      const source = `
        export let main = (): i32 => {
          let arr: array<inline (i32, i32)> = #[];
          return 0;
        };
      `;
      try {
        await compileAndRun(source, 'main');
        assert.fail('Should have failed compilation');
      } catch (e: any) {
        assert.match(e.message, /variable types/);
      }
    });

    test('rejects inline tuple as generic type argument', async () => {
      const source = `
        class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }
        }
        export let main = (): i32 => {
          let b: Box<inline (i32, i32)> = new Box((1, 2));
          return 0;
        };
      `;
      try {
        await compileAndRun(source, 'main');
        assert.fail('Should have failed compilation');
      } catch (e: any) {
        assert.match(e.message, /type arguments/);
      }
    });
  });
});
