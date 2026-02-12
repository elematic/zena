import {test, suite} from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Compiler, CodeGenerator} from '../../lib/index.js';
import type {CompilerHost} from '../../lib/compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The test runs from the compiled lib directory, so we need to go up to find stdlib
// lib/test/wasi -> lib -> compiler -> packages -> root -> packages/stdlib/zena
const stdlibPath = path.resolve(__dirname, '../../../stdlib/zena');

// Simple synchronous host that loads stdlib on demand
class WasiTestHost implements CompilerHost {
  #files: Map<string, string>;
  #target: 'host' | 'wasi';

  constructor(files: Map<string, string>, target: 'host' | 'wasi' = 'host') {
    this.#files = files;
    this.#target = target;
  }

  resolve(specifier: string, _referrer: string): string {
    // zena:console is virtual - map to appropriate implementation based on target
    if (specifier === 'zena:console') {
      return this.#target === 'wasi'
        ? 'zena:console-wasi'
        : 'zena:console-host';
    }
    if (specifier.startsWith('zena:')) return specifier;
    return specifier;
  }

  load(filePath: string): string {
    if (this.#files.has(filePath)) {
      return this.#files.get(filePath)!;
    }

    throw new Error(`File not found: ${filePath}`);
  }
}

// Load stdlib files into a Map
// When target is 'wasi', loads console-wasi instead of console
function loadStdlib(target: 'host' | 'wasi' = 'host'): Map<string, string> {
  const files = new Map<string, string>();

  const stdlibFiles = [
    'string',
    'error',
    'option',
    'sequence',
    'range',
    'immutable-array',
    'fixed-array',
    'growable-array',
    'map',
    'box',
    'iterator',
    'array-iterator',
    // Console interface is shared between host and wasi implementations
    'console-interface',
    // Load appropriate console implementation based on target
    target === 'wasi' ? 'console-wasi' : 'console-host',
  ];

  for (const name of stdlibFiles) {
    const filePath = path.join(stdlibPath, `${name}.zena`);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      files.set(`zena:${name}`, content);
    } catch {
      // Ignore missing files
    }
  }

  return files;
}

suite('WASI build', () => {
  test('should compile simple program with --target wasi', async () => {
    const files = loadStdlib('wasi');

    // Add test file
    const testSource = `
import { console } from 'zena:console';

export let main = () => {
  console.log("Hello, WASI!");
  return 0;
};
`;
    files.set('/test/hello.zena', testSource);

    const host = new WasiTestHost(files, 'wasi');
    const compiler = new Compiler(host);

    try {
      const modules = compiler.compile('/test/hello.zena');

      // Check for errors
      let hasErrors = false;
      for (const mod of modules) {
        if (mod.diagnostics.length > 0) {
          console.error(`Errors in ${mod.path}:`);
          for (const d of mod.diagnostics) {
            console.error(`  ${d.message}`);
          }
          hasErrors = true;
        }
      }

      if (hasErrors) {
        assert.fail('Compilation had errors');
      }

      // Generate code with WASI target
      const codegen = new CodeGenerator(
        modules,
        '/test/hello.zena',
        compiler.semanticContext,
        compiler.checkerContext,
        {target: 'wasi'},
      );

      const bytes = codegen.generate();

      // Validate WASM
      const valid = WebAssembly.validate(bytes as BufferSource);
      if (!valid) {
        // Try to compile to get better error message
        try {
          await WebAssembly.compile(bytes as BufferSource);
        } catch (compileErr) {
          console.error('WASM compile error:', compileErr);
        }
      }
      assert.ok(valid, 'WASM should be valid');

      // Check for WASI imports
      const wasmModule = await WebAssembly.compile(bytes as BufferSource);
      const imports = WebAssembly.Module.imports(wasmModule);
      const exports = WebAssembly.Module.exports(wasmModule);

      // Should have wasi_snapshot_preview1::fd_write import
      const hasFdWrite = imports.some(
        (i) => i.module === 'wasi_snapshot_preview1' && i.name === 'fd_write',
      );
      assert.ok(hasFdWrite, 'Should have fd_write import');

      // Should have memory export
      const hasMemory = exports.some((e) => e.name === 'memory');
      assert.ok(hasMemory, 'Should have memory export');
    } catch (e) {
      console.error('Build failed:', e);
      throw e;
    }
  });

  test('should compile simple program with host target (baseline)', async () => {
    const files = loadStdlib('host');

    // Add test file - no console usage
    const testSource = `
export let add = (a: i32, b: i32) => a + b;
export let main = () => 42;
`;
    files.set('/test/simple.zena', testSource);

    const host = new WasiTestHost(files, 'host');
    const compiler = new Compiler(host);

    const modules = compiler.compile('/test/simple.zena');

    // Check for errors
    for (const mod of modules) {
      assert.strictEqual(mod.diagnostics.length, 0, `Errors in ${mod.path}`);
    }

    // Generate code with host target (default)
    const codegen = new CodeGenerator(
      modules,
      '/test/simple.zena',
      compiler.semanticContext,
      compiler.checkerContext,
      {target: 'host'},
    );

    const bytes = codegen.generate();

    // Validate WASM
    const valid = WebAssembly.validate(bytes as BufferSource);
    assert.ok(valid, 'WASM should be valid with host target');
  });

  test('should compile simple program without console usage', async () => {
    // Load stdlib with wasi target (includes console-wasi, but user code doesn't use it)
    const files = loadStdlib('wasi');

    // Add test file - no console usage
    const testSource = `
export let add = (a: i32, b: i32) => a + b;
export let main = () => 42;
`;
    files.set('/test/simple.zena', testSource);

    const host = new WasiTestHost(files, 'wasi');
    const compiler = new Compiler(host);

    const modules = compiler.compile('/test/simple.zena');

    // Check for errors
    for (const mod of modules) {
      assert.strictEqual(mod.diagnostics.length, 0, `Errors in ${mod.path}`);
    }

    // Generate code with WASI target
    const codegen = new CodeGenerator(
      modules,
      '/test/simple.zena',
      compiler.semanticContext,
      compiler.checkerContext,
      {target: 'wasi'},
    );

    let bytes: Uint8Array;
    try {
      bytes = codegen.generate();
    } catch (e) {
      console.error('Codegen failed:', e);
      throw e;
    }

    // Validate WASM
    const valid = WebAssembly.validate(bytes as BufferSource);
    if (!valid) {
      // Try to compile to get better error message
      try {
        await WebAssembly.compile(bytes as BufferSource);
      } catch (compileErr) {
        console.error('WASM compile error:', compileErr);
      }
    }
    assert.ok(valid, 'WASM should be valid');

    // WASI target always includes fd_write import for consistency
    // (could be optimized with DCE in the future)
    const wasmModule = await WebAssembly.compile(bytes as BufferSource);
    const imports = WebAssembly.Module.imports(wasmModule);

    const hasFdWrite = imports.some(
      (i) => i.module === 'wasi_snapshot_preview1',
    );
    assert.ok(
      hasFdWrite,
      'WASI target should include fd_write import (even when console not used)',
    );
  });
});
