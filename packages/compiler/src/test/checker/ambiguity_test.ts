import {suite, test} from 'node:test';
import {compileAndRun} from '../codegen/utils.js';
import * as assert from 'node:assert';

suite('Ambiguity and Distinguishability Tests', () => {
  test('Distinct types on reference types in union should fail', async () => {
    const source = `
      distinct type IdA = string;
      distinct type IdB = string;

      export let main = (): void => {
        let x: IdA | IdB = "hello" as IdA;
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have failed compilation');
    } catch (e: any) {
      assert.match(
        e.message,
        /Union types cannot contain multiple distinct types/,
      );
    }
  });

  test('Match on distinct types (not supported yet, but would be ambiguous)', async () => {
    // Currently fails because distinct types are not classes.
    // This test just documents that behavior.
    const source = `
      distinct type IdA = string;
      distinct type IdB = string;

      export let main = (): void => {
        let x: string = "hello";
        match (x) {
            case IdA {}: {}
            case IdB {}: {}
        };
      };
    `;

    try {
      await compileAndRun(source, 'main');
      assert.fail('Should have failed compilation');
    } catch (e: any) {
      // Currently fails with "not a class"
      assert.ok(
        e.message.includes('not a class') || e.message.includes('Ambiguous'),
      );
    }
  });

  test('Boxed distinct types are currently indistinguishable', async () => {
    const source = `
      import { Box } from 'zena:box';
      
      distinct type Meters = i32;
      distinct type Seconds = i32;

      export let main = (): boolean => {
        let m = new Box<Meters>(10 as Meters);
        
        // At runtime, Box<Meters> and Box<Seconds> are both Box<i32>
        // So 'm is Box<Seconds>' returns true.
        let isSeconds = m is Box<Seconds>;
        
        return isSeconds;
      };
    `;

    const result = await compileAndRun(source, 'main');
    // Documenting current behavior: they are indistinguishable, so result is true (1)
    assert.strictEqual(
      result,
      1,
      'Boxed distinct types erase to underlying type',
    );
  });
});
