import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - TemplateStringsArray', () => {
  test('should support raw property', async () => {
    const source = `
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): string => {
        return strings.raw[0];
      };
      export let main = (): i32 => {
        let s = tag\`line1\\nline2\`;
        // raw string should contain \\n (2 chars), not newline (1 char)
        // We can't easily check string content in i32 return, so we check length
        return s.length;
      };
    `;

    // "line1\nline2" -> 11 chars (line1 = 5, \n = 1, line2 = 5) -> 11?
    // No, raw string "line1\\nline2" -> 5 + 2 + 5 = 12 chars.
    // Cooked string "line1\nline2" -> 5 + 1 + 5 = 11 chars.

    const result = await compileAndRun(source);
    assert.strictEqual(result, 12);
  });

  test('should support indexing', async () => {
    const source = `
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): string => {
        return strings[0];
      };
      export let main = (): i32 => {
        let s = tag\`hello\`;
        return s.length;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 5);
  });

  test('should support map', async () => {
    const source = `
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        let lengths = strings.map((s: string, i: i32, seq: Sequence<string>) => s.length);
        return lengths[0] + lengths[1];
      };
      export let main = (): i32 => {
        let x = 1;
        // "hello " (6) and " world" (6)
        return tag\`hello \${x} world\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.strictEqual(result, 12);
  });
});
