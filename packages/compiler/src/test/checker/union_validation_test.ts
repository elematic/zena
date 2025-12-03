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
        /Union types cannot contain primitive types like 'i32'/,
      );
    }
  });

  test('Generic instantiation with primitive creating invalid union fails', async () => {
    const source = `
      class Container<T> {
        val: T | null;
        #new() {}
      }

      export let main = (): void => {
        let c = new Container<i32>();
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have failed compilation');
    } catch (e: any) {
      assert.match(
        e.message,
        /Union types cannot contain primitive types like 'i32'/,
      );
      // assert.match(e.message, /This occurred during generic instantiation/);
    }
  });

  test('Valid unions pass', async () => {
    const source = `
      import { Box } from 'zena:box';
      import { String } from 'zena:string';

      class Container<T> {
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
