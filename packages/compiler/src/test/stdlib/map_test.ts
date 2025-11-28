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
      return 'export final class Array<T> { length: i32; }';
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

suite('Stdlib: Map', () => {
  test('implements generic closure', async () => {
    const source = `
      export let run = () => {
        let f = <T>(x: T): T => x;
        return f<i32>(10);
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual((exports.run as Function)(), 10);
  });
});
