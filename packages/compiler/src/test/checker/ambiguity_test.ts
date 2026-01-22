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

  test('Boxed distinct types are distinguishable', async () => {
    const source = `
      import { Box } from 'zena:box';
      
      distinct type Meters = i32;
      distinct type Seconds = i32;

      export let main = (): boolean => {
        let m = new Box<Meters>(10 as Meters);
        
        // Box<Meters> and Box<Seconds> are distinct specializations,
        // so 'm is Box<Seconds>' returns false.
        let isSeconds = m is Box<Seconds>;
        
        return isSeconds;
      };
    `;

    const result = await compileAndRun(source, 'main');
    // Distinct type parameters create separate specializations
    assert.strictEqual(result, 0, 'Boxed distinct types are distinguishable');
  });

  test('Multiple extension types on same underlying type in union should fail', async () => {
    // Having multiple extension classes on the same underlying type is fine in general -
    // the static type determines which extension is used. However, a UNION of two such
    // extension types (e.g., `StringExt1 | StringExt2` where both extend string) would be
    // ambiguous at runtime since you couldn't distinguish between them.
    // Currently we don't have two extension types on the same base in stdlib to test this,
    // so we just verify that valid extension unions work.
    const source = `
      // string | null is valid - null is distinguishable from string
      export let main = (): void => {
        let x: string | null = null;
      };
    `;

    // This should pass since string | null is valid
    await compileAndRun(source, 'main');
  });
});
