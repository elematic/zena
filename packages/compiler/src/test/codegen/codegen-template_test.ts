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
});
