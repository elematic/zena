import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compile} from '../../lib/index.js';

suite('CodeGenerator - Template Literals', () => {
  test('should compile simple template literal', async () => {
    const source = `
      export let main = (): i32 => {
        let s = \`hello world\`;
        return 0;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 0);
  });

  test('should compile empty template literal', async () => {
    const source = `
      export let main = (): i32 => {
        let s = \`\`;
        return 0;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 0);
  });

  test('should compile template literal with string interpolation', async () => {
    const source = `
      export let main = (): i32 => {
        let name = "world";
        let greeting = \`hello \${name}\`;
        return 0;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 0);
  });

  test('should compile template literal with multiple interpolations', async () => {
    const source = `
      export let main = (): i32 => {
        let a = "x";
        let b = "y";
        let c = "z";
        let result = \`\${a} and \${b} and \${c}\`;
        return 0;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 0);
  });

  test('should compile template literal return', async () => {
    const source = `
      export let main = (): string => {
        return \`hello\`;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.ok(result); // Should return a non-null string reference
  });

  test('should compile template literal with escape sequences', async () => {
    const source = `
      export let main = (): i32 => {
        let s = \`line1\\nline2\`;
        return 0;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 0);
  });

  // Tagged template literal tests
  test('should compile tagged template literal without substitutions', async () => {
    const source = `
      let tag = (strings: FixedArray<string>, values: FixedArray<i32>): i32 => {
        return strings.length;
      };
      export let main = (): i32 => {
        return tag\`hello world\`;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    // Should have 1 string (no interpolations means 1 quasi)
    assert.strictEqual(result, 1);
  });

  test('should compile tagged template literal with single substitution', async () => {
    const source = `
      let tag = (strings: FixedArray<string>, values: FixedArray<i32>): i32 => {
        return strings.length;
      };
      export let main = (): i32 => {
        let x = 42;
        return tag\`value is \${x}\`;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    // Should have 2 strings (before and after the interpolation)
    assert.strictEqual(result, 2);
  });

  test('should compile tagged template literal with multiple substitutions', async () => {
    const source = `
      let tag = (strings: FixedArray<string>, values: FixedArray<i32>): i32 => {
        return strings.length;
      };
      export let main = (): i32 => {
        let a = 1;
        let b = 2;
        let c = 3;
        return tag\`\${a} + \${b} = \${c}\`;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    // Should have 4 strings (before a, between a and b, between b and c, after c)
    assert.strictEqual(result, 4);
  });

  test('should compile tagged template literal that returns values count', async () => {
    const source = `
      let tag = (strings: FixedArray<string>, values: FixedArray<i32>): i32 => {
        return values.length;
      };
      export let main = (): i32 => {
        let a = 1;
        let b = 2;
        return tag\`\${a} + \${b}\`;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    // Should have 2 values
    assert.strictEqual(result, 2);
  });

  test('should compile tagged template literal that accesses first value', async () => {
    const source = `
      let tag = (strings: FixedArray<string>, values: FixedArray<i32>): i32 => {
        return values[0];
      };
      export let main = (): i32 => {
        let x = 42;
        return tag\`value: \${x}\`;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 42);
  });

  test('should compile tagged template literal that sums values', async () => {
    const source = `
      let tag = (strings: FixedArray<string>, values: FixedArray<i32>): i32 => {
        return values[0] + values[1];
      };
      export let main = (): i32 => {
        let a = 10;
        let b = 20;
        return tag\`\${a} plus \${b}\`;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    assert.strictEqual(result, 30);
  });

  test('should preserve template strings array identity across calls', async () => {
    // The strings array passed to a tag function should be the same reference
    // every time the same tagged template expression is evaluated. This is
    // important for caching: the strings array can be used as a cache key.
    const source = `
      let captureStrings = (strings: FixedArray<string>, values: FixedArray<i32>): FixedArray<string> => {
        return strings;
      };
      let go = (): FixedArray<string> => {
        return captureStrings\`hello\`;
      };
      export let main = (): i32 => {
        let first = go();
        let second = go();
        // Return 1 if same reference, 0 if different
        if (first == second) {
          return 1;
        }
        return 0;
      };
    `;

    const wasm = compile(source);
    const module: any = await WebAssembly.instantiate(wasm.buffer, {});
    const result = (module.instance.exports.main as Function)();
    // Should return 1, meaning both calls returned the same strings array reference
    assert.strictEqual(result, 1);
  });
});
