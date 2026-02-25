import {suite, test} from 'node:test';
import * as assert from 'node:assert';
import {compileAndRun} from './codegen/utils.js';

suite('Enums', () => {
  test('Integer Enum', async () => {
    const result = await compileAndRun(`
      enum Color {
        Red,
        Green,
        Blue
      }

      export let main = () => {
        let c = Color.Green;
        return c;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('Integer Enum with Initializers', async () => {
    const result = await compileAndRun(`
      enum Status {
        Ok = 200,
        NotFound = 404,
        Error = 500
      }

      export let main = () => {
        return Status.NotFound;
      };
    `);
    assert.strictEqual(result, 404);
  });

  test('Enum Type Annotation', async () => {
    const result = await compileAndRun(`
      enum Color {
        Red,
        Green
      }

      let getColor = (c: Color): i32 => {
        return c as i32;
      };

      export let main = () => {
        let c: Color = Color.Red;
        return getColor(c);
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('Enum in Struct', async () => {
    const result = await compileAndRun(`
      enum Color { Red, Green }

      class Pixel {
        color: Color;
        #new(c: Color) {
          this.color = c;
        }
      }

      export let main = () => {
        let p = new Pixel(Color.Green);
        return p.color as i32;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('Function referencing enum declared later', async () => {
    // This tests that enums are pre-declared, allowing forward references
    const result = await compileAndRun(`
      // Function declared BEFORE the enum
      let getStatusCode = (s: Status): i32 => {
        return s as i32;
      };

      // Enum declared AFTER the function
      enum Status {
        Ok = 200,
        NotFound = 404
      }

      export let main = () => {
        return getStatusCode(Status.NotFound);
      };
    `);
    assert.strictEqual(result, 404);
  });
});
