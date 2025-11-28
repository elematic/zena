import {suite, test} from 'node:test';
import {Compiler, type CompilerHost} from '../../lib/compiler.js';
import {CodeGenerator} from '../../lib/codegen/index.js';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stdlibPath = join(__dirname, '../../stdlib');

function compileToWasm(input: string): Uint8Array {
  const host: CompilerHost = {
    load: (path: string) => {
      if (path === '/main.zena') return input;
      if (path.startsWith('zena:')) {
        const name = path.substring(5);
        return readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
      }
      throw new Error(`File not found: ${path}`);
    },
    resolve: (specifier: string, referrer: string) => specifier,
  };

  const compiler = new Compiler(host);
  const program = compiler.bundle('/main.zena');
  const generator = new CodeGenerator(program);
  return generator.generate();
}

suite('CodeGenerator - Cast Optimization', () => {
  test('should elide cast for distinct type alias of string', () => {
    const codeNoCast = `
      type ID = string;
      export let main = (s: string): string => {
        return s;
      };
    `;

    const codeWithCast = `
      type ID = string;
      export let main = (s: string): string => {
        return s as ID;
      };
    `;

    const wasmNoCast = compileToWasm(codeNoCast);
    const wasmWithCast = compileToWasm(codeWithCast);

    // If cast is elided, the binaries should be identical (or at least same size)
    // Note: They might differ slightly if type names are embedded or something,
    // but the code section size should be key.
    // For now, let's check total size.
    assert.strictEqual(
      wasmWithCast.length,
      wasmNoCast.length,
      'Cast should be elided (binary size mismatch)',
    );
  });

  test('should elide cast for distinct type alias of class', () => {
    const codeNoCast = `
      class Person {}
      type Manager = Person;
      export let main = (p: Person): Person => {
        return p;
      };
    `;

    const codeWithCast = `
      class Person {}
      type Manager = Person;
      export let main = (p: Person): Person => {
        return p as Manager;
      };
    `;

    const wasmNoCast = compileToWasm(codeNoCast);
    const wasmWithCast = compileToWasm(codeWithCast);

    assert.strictEqual(
      wasmWithCast.length,
      wasmNoCast.length,
      'Cast should be elided (binary size mismatch)',
    );
  });
});
