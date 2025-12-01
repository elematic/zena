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
