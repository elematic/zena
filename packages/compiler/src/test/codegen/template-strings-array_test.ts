import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - TemplateStringsArray', () => {
  test('should access length property', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        return strings.length;
      };
      export let main = (): i32 => {
        return tag\`hello world\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('should access strings by index', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        // Just return length of first string to verify indexing works
        let first = strings[0];
        return first.length;
      };
      export let main = (): i32 => {
        return tag\`hello\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 5); // "hello".length
  });

  test('should access raw strings', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        let raw = strings.raw;
        return raw.length;
      };
      export let main = (): i32 => {
        let x = 1;
        return tag\`before \${x} after\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 2); // 2 raw strings
  });

  test('should handle multiple substitutions', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        return strings.length;
      };
      export let main = (): i32 => {
        let a = 1;
        let b = 2;
        let c = 3;
        return tag\`\${a} + \${b} = \${c}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 4); // 4 string parts
  });

  test('should preserve TemplateStringsArray identity across calls', async () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let captureStrings = (strings: TemplateStringsArray, values: FixedArray<i32>): TemplateStringsArray => {
        return strings;
      };
      let go = (): TemplateStringsArray => {
        return captureStrings\`hello\`;
      };
      export let main = (): i32 => {
        let first = go();
        let second = go();
        // Return 1 if same reference, 0 if different
        if (first === second) {
          return 1;
        }
        return 0;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
