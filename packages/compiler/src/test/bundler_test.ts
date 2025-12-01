import {describe, it} from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Bundler} from '../lib/bundler.js';
import {NodeType} from '../lib/ast.js';
import {Compiler, type CompilerHost, type Module} from '../lib/compiler.js';
import {Parser} from '../lib/parser.js';
import {CodeGenerator} from '../lib/codegen/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibPath = path.resolve(__dirname, '../stdlib');

function createModule(path: string, code: string): Module {
  const parser = new Parser(code);
  const ast = parser.parse();
  return {
    path,
    source: code,
    ast,
    imports: new Map(),
    exports: new Map(),
    diagnostics: [],
    isStdlib: true, // Bypass well-known type checks for unit tests
  };
}

describe('Bundler', () => {
  it('renames top-level declarations and references', () => {
    const modA = createModule(
      'a.zena',
      `
      let x = 1;
      let y = x + 1;
    `,
    );

    const bundler = new Bundler([modA], modA);
    const bundle = bundler.bundle();

    assert.strictEqual(bundle.body.length, 2);

    const decl1 = bundle.body[0] as any;
    const decl2 = bundle.body[1] as any;

    // Check renaming
    assert.match(decl1.pattern.name, /^m0_x$/);
    assert.match(decl2.pattern.name, /^m0_y$/);

    // Check reference
    assert.strictEqual(decl2.init.left.name, decl1.pattern.name);
  });

  it('renames imports', () => {
    const modA = createModule(
      'a.zena',
      `
      import { x } from './b.zena';
      let y = x;
    `,
    );
    const modB = createModule(
      'b.zena',
      `
      export let x = 10;
    `,
    );

    // Manually resolve imports for test
    modA.imports.set('./b.zena', 'b.zena');

    const bundler = new Bundler([modA, modB], modA);
    const bundle = bundler.bundle();

    // Should have 2 statements (modA let y, modB let x) - imports are removed
    assert.strictEqual(bundle.body.length, 2);

    // Find statements
    const stmtY = bundle.body.find(
      (s: any) =>
        s.type === NodeType.VariableDeclaration && s.pattern.name.includes('y'),
    ) as any;
    const stmtX = bundle.body.find(
      (s: any) =>
        s.type === NodeType.VariableDeclaration && s.pattern.name.includes('x'),
    ) as any;

    assert.ok(stmtY);
    assert.ok(stmtX);

    // Check that y is initialized with x's mangled name
    assert.strictEqual(stmtY.init.name, stmtX.pattern.name);
  });

  it('does not rename locals', () => {
    const modA = createModule(
      'a.zena',
      `
      let x = 1;
      let f = (x: i32) => x;
    `,
    );

    const bundler = new Bundler([modA], modA);
    const bundle = bundler.bundle();

    const stmtF = bundle.body[1] as any;
    const param = stmtF.init.params[0];
    const body = stmtF.init.body; // Expression body

    assert.strictEqual(param.name.name, 'x'); // Param should stay 'x'
    assert.strictEqual(body.name, 'x'); // Body usage should stay 'x'
  });
});

describe('Exports', () => {
  it('should export entry point functions with original names', async () => {
    const host: CompilerHost = {
      load: (specifier: string) => {
        if (specifier === '/main.zena') {
          return `
              import { add } from './math';
              import { FixedArray } from 'zena:array';
              export let main = () => add(1, 2);
              export declare function print(s: string): void;
            `;
        }
        if (specifier === '/math.zena') {
          return `
              export let add = (a: i32, b: i32) => a + b;
            `;
        }
        if (specifier.startsWith('zena:')) {
          const name = specifier.substring(5);
          const filePath = path.join(stdlibPath, `${name}.zena`);
          return fs.readFileSync(filePath, 'utf-8');
        }
        return '';
      },
      resolve: (specifier: string, referrer: string) => {
        if (specifier === 'zena:array') return 'zena:array';
        if (specifier === 'zena:string') return 'zena:string';
        if (specifier.startsWith('./')) {
          return '/' + specifier.substring(2) + '.zena';
        }
        return specifier;
      },
    };

    const compiler = new Compiler(host);
    const program = compiler.bundle('/main.zena');

    const generator = new CodeGenerator(program);
    const wasmBytes = generator.generate();

    // Verify exports
    const module = await WebAssembly.compile(wasmBytes as any);
    const exports = WebAssembly.Module.exports(module);

    const mainExport = exports.find((e) => e.name === 'main');
    assert.ok(mainExport, 'Should export "main"');
    assert.strictEqual(mainExport.kind, 'function');

    const printExport = exports.find((e) => e.name === 'print');
    assert.ok(printExport, 'Should export "print"');
    assert.strictEqual(printExport.kind, 'function');

    // Should NOT export "add" (it's imported, not re-exported)
    const addExport = exports.find((e) => e.name === 'add');
    assert.strictEqual(addExport, undefined, 'Should not export "add"');
  });

  it('should export class factory', async () => {
    const host: CompilerHost = {
      load: (specifier: string) => {
        if (specifier === '/main.zena') {
          return `
              import { FixedArray } from 'zena:array';
              export class Point {
                x: i32;
                y: i32;
                #new(x: i32, y: i32) {
                  this.x = x;
                  this.y = y;
                }
              }
            `;
        }
        if (specifier.startsWith('zena:')) {
          const name = specifier.substring(5);
          const filePath = path.join(stdlibPath, `${name}.zena`);
          return fs.readFileSync(filePath, 'utf-8');
        }
        return '';
      },
      resolve: (specifier: string) => {
        if (specifier === 'zena:array') return 'zena:array';
        if (specifier === 'zena:string') return 'zena:string';
        return specifier;
      },
    };

    const compiler = new Compiler(host);
    const program = compiler.bundle('/main.zena');

    const generator = new CodeGenerator(program);
    const wasmBytes = generator.generate();

    const module = await WebAssembly.compile(wasmBytes as any);
    const exports = WebAssembly.Module.exports(module);

    const pointExport = exports.find((e) => e.name === 'Point');
    assert.ok(pointExport, 'Should export "Point" factory');
    assert.strictEqual(pointExport.kind, 'function');
  });
});
