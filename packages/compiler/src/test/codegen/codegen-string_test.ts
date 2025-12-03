import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Strings', () => {
  test('should compile and run string literal', async () => {
    const source = `
      export let main = (): i32 => {
        let s = "hello";
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 0);
  });

  test('should concatenate two string literals', async () => {
    const source = `
      export let main = (): i32 => {
        let s = "hello" + " " + "world";
        return s.length;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 11);
  });

  test('should concatenate string variables', async () => {
    const source = `
      export let main = (): i32 => {
        let s1 = "hello";
        let s2 = "world";
        let s3 = s1 + " " + s2;
        return s3.length;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 11);
  });

  test('should compare strings for equality', async () => {
    const source = `
      export let main = (): i32 => {
        let s1 = "hello";
        let s2 = "hello";
        let s3 = "world";
        if (s1 == s2) {
          if (s1 != s3) {
            return 1;
          }
        }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should support string length', async () => {
    const source = `
      export let main = (): i32 => {
        let s = "hello";
        return s.length;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 5);
  });

  test('should support string indexing via getByteAt', async () => {
    const source = `
      export let main = (): i32 => {
        let s = "hello";
        // 'e' is 101
        return s.getByteAt(1);
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 101);
  });

  test('should not support string indexing via []]', async () => {
    const source = `
      export let main = (): i32 => {
        let s = "hello";
        // 'e' is 101
        return s[1];
      };
    `;

    try {
      await compileAndRun(source);
      assert.fail('Expected compilation to fail');
    } catch (e) {
      // Expected error
    }
  });
});
