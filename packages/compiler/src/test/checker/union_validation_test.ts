import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';
import * as assert from 'node:assert';

suite('Union Validation Tests', () => {
  test('Explicit primitive union fails', async () => {
    const source = `
      export let main = (): void => {
        let x: i32 | null = null;
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have failed compilation');
    } catch (e: any) {
      assert.match(
        e.message,
        /cannot mix primitive types with reference types/,
      );
    }
  });

  test('Generic instantiation with primitive creating invalid union fails', async () => {
    const source = `
      class Container<T extends anyref> {
        val: T | null;
        #new() {}
      }

      export let main = (): void => {
        // This should fail because i32 does not satisfy "extends anyref"
        let c = new Container<i32>();
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have failed compilation');
    } catch (e: any) {
      assert.match(e.message, /does not satisfy constraint/i);
    }
  });

  test('Unbounded type parameter in union with null fails at declaration', async () => {
    const source = `
      // This should fail at the class declaration because T is unbounded
      // and T | null could be i32 | null which is invalid
      class Container<T> {
        val: T | null;
        #new() {}
      }

      export let main = (): void => {
        let c = new Container<string>();
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have failed compilation');
    } catch (e: any) {
      assert.match(
        e.message,
        /unbounded type parameters mixed with reference types/i,
      );
    }
  });

  test('Valid unions pass', async () => {
    const source = `
      import { Box } from 'zena:box';
      import { String } from 'zena:string';

      // Valid: T is bounded by anyref, so T | null is OK
      class Container<T extends anyref> {
        val: T | null;
        #new() {
          this.val = null;
        }
      }

      export let main = (): void => {
        // Valid: Box is a reference type
        let x: Box<i32> | null = null;
        
        // Valid: Instantiating generic with reference type
        let c = new Container<Box<i32>>();
        
        // Valid: Instantiating generic with String (reference type)
        let s = new Container<string>();

        // Valid: Array is a reference type
        let arr: array<i32> | null = null;

        // Valid: ByteArray is a reference type
        let bytes: ByteArray | null = null;

        // Valid: String is a reference type (extension class)
        let str: string | null = null;
      };
    `;

    await compileAndRun(source, 'main');
  });
});
