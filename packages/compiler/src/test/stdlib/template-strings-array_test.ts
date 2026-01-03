import assert from 'node:assert';
import {suite, test} from 'node:test';
import {Compiler, type CompilerHost} from '../../lib/compiler.js';
import {TypeChecker} from '../../lib/checker/index.js';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stdlibPath = join(__dirname, '../../../stdlib/zena');

const createHost = (source: string): CompilerHost => ({
  load: (p: string) => {
    if (p === '/main.zena') return source;
    if (p.startsWith('zena:')) {
      const name = p.substring(5);
      return readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
    }
    throw new Error(`File not found: ${p}`);
  },
  resolve: (specifier: string) => specifier,
});

const checkSource = (source: string) => {
  const host = createHost(source);
  const compiler = new Compiler(host);
  const program = compiler.bundle('/main.zena');
  const checker = new TypeChecker(program, compiler, {
    path: '/main.zena',
    exports: new Map(),
    isStdlib: true,
  } as any);
  checker.preludeModules = compiler.preludeModules;
  return checker.check();
};

suite('Stdlib: TemplateStringsArray', () => {
  // TODO: Checker should reject index assignment without operator []=
  test('should reject index assignment on TemplateStringsArray', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        strings[0] = "changed";
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for index assignment on TemplateStringsArray',
    );
  });

  // TODO: Checker should reject index assignment on ImmutableArray
  test('should reject index assignment on raw property', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        strings.raw[0] = "changed";
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for index assignment on raw property',
    );
  });

  // TODO: Checker should reject assignment to getter-only properties
  test('should reject assignment to length property', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        strings.length = 5;
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for assignment to length property',
    );
  });

  test('should reject access to private fields', () => {
    const source = `
      import {TemplateStringsArray} from 'zena:template-strings-array';
      
      let tag = (strings: TemplateStringsArray, values: FixedArray<i32>): i32 => {
        let s = strings.#strings;
        return 0;
      };
    `;

    const diagnostics = checkSource(source);
    assert.ok(
      diagnostics.length > 0,
      'Expected type error for accessing private field',
    );
  });
});
