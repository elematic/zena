import assert from 'node:assert';
import {suite, test} from 'node:test';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {Compiler} from '../../lib/compiler.js';

class MockHost {
  files = new Map<string, string>();

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) return specifier;
    if (specifier.startsWith('./')) return specifier.substring(2);
    return specifier;
  }

  load(path: string): string {
    if (this.files.has(path)) return this.files.get(path)!;
    if (path === 'zena:string')
      return 'export final class String { bytes: ByteArray; length: i32; }';
    if (path === 'zena:array')
      return `
        export final extension class FixedArray<T> on array<T> {
          @intrinsic('array.len')
          declare length: i32;
          @intrinsic('array.get')
          declare operator [](index: i32): T;
          @intrinsic('array.set')
          declare operator []=(index: i32, value: T): void;
        }
      `;
    if (path === 'zena:console')
      return 'export class Console {} export let console = new Console();';
    throw new Error(`File not found: ${path}`);
  }
}

async function compileAndRun(source: string): Promise<any> {
  const host = new MockHost();
  host.files.set('main.zena', source);

  const compiler = new Compiler(host);
  const program = compiler.bundle('main.zena');
  const generator = new CodeGenerator(program);
  const wasm = generator.generate();

  const result = await WebAssembly.instantiate(wasm, {});
  return (result as any).instance.exports;
}

suite('Codegen: Closures', () => {
  test('compiles and runs a simple closure', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let f = () => x + 1;
        return f();
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual((exports.run as Function)(), 11);
  });

  test('compiles and runs a closure with parameters', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let f = (y: i32) => x + y;
        return f(5);
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual((exports.run as Function)(), 15);
  });

  test('compiles and runs a closure capturing multiple variables', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let y = 20;
        let f = () => x + y;
        return f();
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual((exports.run as Function)(), 30);
  });

  test('compiles and runs nested closures', async () => {
    const source = `
      export let run = () => {
        let x = 10;
        let f = (y: i32) => {
            let g = (z: i32) => x + y + z;
            return g(5);
        };
        return f(20);
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual((exports.run as Function)(), 35);
  });
});
