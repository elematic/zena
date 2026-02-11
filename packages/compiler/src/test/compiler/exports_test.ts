import {describe, it} from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Compiler, type CompilerHost} from '../../lib/compiler.js';
import {CodeGenerator} from '../../lib/codegen/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stdlibPath = path.resolve(__dirname, '../../../stdlib/zena');

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
        // zena:console is virtual - map to console-host
        if (specifier === 'zena:console') return 'zena:console-host';
        if (specifier === 'zena:array') return 'zena:array';
        if (specifier === 'zena:string') return 'zena:string';
        if (specifier.startsWith('./')) {
          return '/' + specifier.substring(2) + '.zena';
        }
        return specifier;
      },
    };

    const compiler = new Compiler(host);
    const modules = compiler.compile('/main.zena');

    const generator = new CodeGenerator(
      modules,
      '/main.zena',
      compiler.semanticContext,
      compiler.checkerContext,
    );
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
        // zena:console is virtual - map to console-host
        if (specifier === 'zena:console') return 'zena:console-host';
        if (specifier === 'zena:array') return 'zena:array';
        if (specifier === 'zena:string') return 'zena:string';
        return specifier;
      },
    };

    const compiler = new Compiler(host);
    const modules = compiler.compile('/main.zena');

    const generator = new CodeGenerator(
      modules,
      '/main.zena',
      compiler.semanticContext,
      compiler.checkerContext,
    );
    const wasmBytes = generator.generate();

    const module = await WebAssembly.compile(wasmBytes as any);
    const exports = WebAssembly.Module.exports(module);

    const pointExport = exports.find((e) => e.name === 'Point');
    assert.ok(pointExport, 'Should export "Point" factory');
    assert.strictEqual(pointExport.kind, 'function');
  });
});
