import {describe, it} from 'node:test';
import assert from 'node:assert';
import {loadStdlibModule, resolveStdlibSpecifier} from '@zena-lang/stdlib';
import {Compiler, type CompilerHost} from '../../lib/compiler.js';
import {CodeGenerator} from '../../lib/codegen/index.js';

describe('Exports', () => {
  it('should export entry point functions with original names', async () => {
    const host: CompilerHost = {
      load: (specifier: string) => {
        if (specifier === '/main.zena') {
          return `
              import { add } from './math';
              import { FixedArray } from 'zena:array';
              export let main = () => add(1, 2);
              export declare function print(s: String): void;
            `;
        }
        if (specifier === '/math.zena') {
          return `
              export let add = (a: i32, b: i32) => a + b;
            `;
        }
        if (specifier.startsWith('zena:')) {
          return loadStdlibModule(specifier);
        }
        return '';
      },
      resolve: (specifier: string, referrer: string) => {
        // Handles zena:<name> imports (including the virtual zena:console)
        // and relative imports between stdlib modules.
        const stdlibResolved = resolveStdlibSpecifier(
          specifier,
          referrer,
          'host',
        );
        if (stdlibResolved !== null) return stdlibResolved;
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
                var x: i32;
                var y: i32;
                new(x: i32, y: i32) {
                  this.x = x;
                  this.y = y;
                }
              }
            `;
        }
        if (specifier.startsWith('zena:')) {
          return loadStdlibModule(specifier);
        }
        return '';
      },
      resolve: (specifier: string, referrer: string) => {
        // Handles zena:<name> imports (including the virtual zena:console)
        // and relative imports between stdlib modules.
        return resolveStdlibSpecifier(specifier, referrer, 'host') ?? specifier;
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
