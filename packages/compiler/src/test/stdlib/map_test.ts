import assert from 'node:assert';
import {suite, test} from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {Compiler} from '../../lib/compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibPath = path.resolve(__dirname, '../../stdlib');

class MockHost {
  files = new Map<string, string>();

  resolve(specifier: string, referrer: string): string {
    if (specifier.startsWith('zena:')) return specifier;
    if (specifier.startsWith('./')) return specifier.substring(2);
    return specifier;
  }

  load(specifier: string): string {
    if (this.files.has(specifier)) return this.files.get(specifier)!;
    if (specifier.startsWith('zena:')) {
      const name = specifier.substring(5);
      const filePath = path.join(stdlibPath, `${name}.zena`);
      return fs.readFileSync(filePath, 'utf-8');
    }
    throw new Error(`File not found: ${specifier}`);
  }
}

async function compileAndRun(source: string): Promise<any> {
  const host = new MockHost();
  host.files.set('main.zena', source);

  const compiler = new Compiler(host);
  const program = compiler.bundle('main.zena');
  const generator = new CodeGenerator(program);
  const wasm = generator.generate();

  const imports = {
    console: {
      log_i32: () => {},
      log_f32: () => {},
      log_string: () => {},
      error_string: () => {},
      warn_string: () => {},
      info_string: () => {},
      debug_string: () => {},
    },
  };

  const result = await WebAssembly.instantiate(wasm, imports);
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
      export let map = <T, U>(arr: FixedArray<T>, f: (item: T) => U): FixedArray<U> => {
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
