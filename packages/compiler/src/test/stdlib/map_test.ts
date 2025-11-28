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
      class Box { value: i32; }
      export let run = (): i32 => {
        let f = <T>(x: T): T => x;
        let b = new Box();
        b.value = 10;
        return (f<Box>(b) as Box).value;
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual((exports.run as Function)(), 10);
  });

  test('array map function', async () => {
    const source = `
      export let map = <T, U>(arr: Array<T>, f: (item: T) => U): Array<U> => {
        let x = arr[0];
        let y = f(x);
        return #[y];
      };

      export let run = () => {
        let arr = #[10];
        let mapped = map(arr, (x: i32) => x * 2);
        return mapped[0];
      };
    `;
    const exports = await compileAndRun(source);
    assert.strictEqual((exports.run as Function)(), 20);
  });
});
