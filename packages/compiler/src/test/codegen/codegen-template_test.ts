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
      let tag = (strings: Array<string>, values: Array<i32>): i32 => {
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
      let tag = (strings: Array<string>, values: Array<i32>): i32 => {
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
      let tag = (strings: Array<string>, values: Array<i32>): i32 => {
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
      let tag = (strings: Array<string>, values: Array<i32>): i32 => {
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
      let tag = (strings: Array<string>, values: Array<i32>): i32 => {
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
      let tag = (strings: Array<string>, values: Array<i32>): i32 => {
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

  // Note: A test for template strings array identity stability would require
  // reference equality comparison (ref.eq) which may not be fully implemented.
  // The identity stability property is important for caching: the strings array
  // should be the same reference every time the same tagged template expression
  // is evaluated. This should be tested when ref.eq support is available.
});
