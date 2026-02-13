/**
 * Tests for type identity issues that arise when:
 * 1. Generic types are instantiated (creating copies with spread)
 * 2. The bundler renames types to avoid collisions
 * 3. Type comparisons use the `name` property (via typeToString)
 *
 * The core problem: instantiated types have a snapshot of the name at
 * instantiation time, but the bundler later mutates the original type's name.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {checkSource, compileAndRun} from './codegen/utils.js';

suite('Type Identity', () => {
  suite('Generic instantiation across modules', () => {
    test('should handle FixedArray<i32> from stdlib', async () => {
      // This test uses FixedArray which is defined in stdlib (zena:fixed-array)
      // The bundler will rename it to something like m2_FixedArray
      // If the type identity system is working, this should compile without errors
      const result = await compileAndRun(`
        export let main = () => {
          let arr = new FixedArray<i32>(3, 0);
          arr[0] = 10;
          arr[1] = 20;
          arr[2] = 30;
          return arr[0] + arr[1] + arr[2];
        };
      `);
      assert.strictEqual(result, 60);
    });

    test('should handle generic class from user module', async () => {
      // Define a generic class in one module and use it in another
      const files = {
        '/main.zena': `
          import { Container } from 'container.zena';
          
          export let main = () => {
            let c = new Container<i32>(42);
            return c.value;
          };
        `,
        'container.zena': `
          export class Container<T> {
            value: T;
            #new(v: T) {
              this.value = v;
            }
          }
        `,
      };
      const result = await compileAndRun(files, {path: '/main.zena'});
      assert.strictEqual(result, 42);
    });

    test('should compare instantiated generic types correctly', async () => {
      // This tests that two uses of the same generic instantiation are seen as equal
      const files = {
        '/main.zena': `
          import { Container, wrap, unwrap } from 'container.zena';
          
          export let main = () => {
            let c: Container<i32> = wrap(100);
            return unwrap(c);
          };
        `,
        'container.zena': `
          export class Container<T> {
            value: T;
            #new(v: T) {
              this.value = v;
            }
          }
          
          export let wrap = (x: i32): Container<i32> => new Container<i32>(x);
          export let unwrap = (c: Container<i32>): i32 => c.value;
        `,
      };
      const result = await compileAndRun(files, {path: '/main.zena'});
      assert.strictEqual(result, 100);
    });

    test('should handle nested generic instantiation', async () => {
      // Container<Container<i32>> - multiple levels of instantiation
      const files = {
        '/main.zena': `
          import { Container } from 'container.zena';
          
          export let main = () => {
            let inner = new Container<i32>(42);
            let outer = new Container<Container<i32>>(inner);
            return outer.value.value;
          };
        `,
        'container.zena': `
          export class Container<T> {
            value: T;
            #new(v: T) {
              this.value = v;
            }
          }
        `,
      };
      const result = await compileAndRun(files, {path: '/main.zena'});
      assert.strictEqual(result, 42);
    });

    test('should handle generic method returning instantiated type', async () => {
      // A method that returns FixedArray<T> where T comes from class type param
      const result = await compileAndRun(`
        class Wrapper<T> {
          #new() {}
          
          makeArray(v: T): FixedArray<T> {
            let arr = new FixedArray<T>(1, v);
            return arr;
          }
        }
        
        export let main = () => {
          let w = new Wrapper<i32>();
          let arr = w.makeArray(99);
          return arr[0];
        };
      `);
      assert.strictEqual(result, 99);
    });
  });

  suite('Type comparison in bundled programs', () => {
    test('should correctly check assignability of generic instances', () => {
      // This should type-check without errors
      const diagnostics = checkSource(`
        class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }
        }
        
        let getBox = (): Box<i32> => new Box(1);
        let useBox = (b: Box<i32>) => b.value;
        
        export let main = () => {
          let b: Box<i32> = getBox();
          return useBox(b);
        };
      `);
      assert.strictEqual(
        diagnostics.length,
        0,
        `Expected no errors but got: ${diagnostics.map((d) => d.message).join(', ')}`,
      );
    });

    test('should reject mismatched generic instances', () => {
      // Box<i32> should not be assignable to Box<f32>
      const diagnostics = checkSource(`
        class Box<T> {
          value: T;
          #new(v: T) { this.value = v; }
        }
        
        export let main = () => {
          let b: Box<f32> = new Box<i32>(1);
          return 0;
        };
      `);
      assert.ok(
        diagnostics.length > 0,
        'Expected type error for mismatched generics',
      );
    });
  });
});
