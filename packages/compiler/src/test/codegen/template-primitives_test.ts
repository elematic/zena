import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun, compileToWasm} from './utils.js';

suite('Template Literals - Binary Size', () => {
  test('DCE removes unused string-convert functions', async () => {
    // String-only template literal - does NOT use any string-convert functions
    const stringOnlySource = `
      export let main = (): string => {
        let name = "world";
        return \`hello \${name}\`;
      };
    `;

    // Template literal with i32 - USES i32ToString from string-convert
    const withPrimitiveSource = `
      export let main = (): string => {
        let n: i32 = 42;
        return \`value: \${n}\`;
      };
    `;

    const stringOnlyBytes = compileToWasm(stringOnlySource, '/main.zena', {
      dce: true,
    });
    const withPrimitiveBytes = compileToWasm(
      withPrimitiveSource,
      '/main.zena',
      {dce: true},
    );

    console.log(`String-only template (DCE): ${stringOnlyBytes.length} bytes`);
    console.log(`With i32 primitive (DCE): ${withPrimitiveBytes.length} bytes`);
    console.log(
      `Difference: ${withPrimitiveBytes.length - stringOnlyBytes.length} bytes`,
    );

    // The primitive version should be significantly larger because it includes
    // the string conversion functions. If DCE weren't working, both would be
    // the same size (both bloated with all string-convert functions).
    const sizeDifference = withPrimitiveBytes.length - stringOnlyBytes.length;
    assert.ok(
      sizeDifference > 400,
      `String-convert functions should add >400 bytes when used. ` +
        `String-only: ${stringOnlyBytes.length}, With primitive: ${withPrimitiveBytes.length}, ` +
        `Difference: ${sizeDifference} bytes. ` +
        `If difference is small, DCE may not be removing unused functions.`,
    );

    // Also verify string-only stays small (sanity check)
    assert.ok(
      stringOnlyBytes.length < 1000,
      `String-only binary should be <1KB, got ${stringOnlyBytes.length} bytes`,
    );

    // The primitive version should still be reasonable (not bloated with all conversions)
    assert.ok(
      withPrimitiveBytes.length < 2000,
      `i32 template binary should be <2KB, got ${withPrimitiveBytes.length} bytes`,
    );
  });

  test('baseline: template literal with no interpolation binary size', async () => {
    // Simplest possible template literal
    const source = `
      export let main = (): string => {
        return \`hello world\`;
      };
    `;

    const bytes = compileToWasm(source);
    console.log(
      `No-interpolation template literal binary size: ${bytes.length} bytes`,
    );

    assert.ok(bytes.length > 0);
  });
});

suite('Template Literals - Primitive Support', () => {
  test('i32 in template literal', async () => {
    const source = `
      export let main = (): string => {
        let n: i32 = 42;
        return \`value: \${n}\`;
      };
    `;

    const result = await compileAndRun(source);
    // Should return a non-null string reference
    assert.ok(result);
  });

  test('negative i32 in template literal', async () => {
    const source = `
      export let main = (): string => {
        let n: i32 = -123;
        return \`value: \${n}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.ok(result);
  });

  test('i64 in template literal', async () => {
    const source = `
      export let main = (): string => {
        let n: i64 = 9007199254740992 as i64;
        return \`value: \${n}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.ok(result);
  });

  test('f32 in template literal', async () => {
    const source = `
      export let main = (): string => {
        let n: f32 = 3.14 as f32;
        return \`value: \${n}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.ok(result);
  });

  test('bool in template literal', async () => {
    const source = `
      export let main = (): string => {
        let b = true;
        return \`value: \${b}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.ok(result);
  });

  test('multiple primitives in template literal', async () => {
    const source = `
      export let main = (): string => {
        let a: i32 = 1;
        let b: i32 = 2;
        return \`\${a} + \${b} = \${a + b}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.ok(result);
  });

  test('mixed primitives and strings in template literal', async () => {
    const source = `
      export let main = (): string => {
        let name = "answer";
        let value: i32 = 42;
        return \`The \${name} is \${value}\`;
      };
    `;

    const result = await compileAndRun(source);
    assert.ok(result);
  });

  // Binary size tracking test - includes i32 interpolation
  test('i32 template literal binary size', async () => {
    const source = `
      export let main = (): string => {
        let n: i32 = 42;
        return \`value: \${n}\`;
      };
    `;

    const bytes = compileToWasm(source);
    console.log(`i32 template literal binary size: ${bytes.length} bytes`);

    // This will pull in i32ToString from string-convert
    // The size increase from baseline should be reasonable
    assert.ok(bytes.length > 0);
  });
});
