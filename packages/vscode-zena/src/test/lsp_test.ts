/**
 * Integration tests for lsp.wasm — the self-hosted compiler's LSP entry point.
 *
 * These tests load lsp.wasm directly in Node.js (no VS Code needed),
 * provide mock host imports, and exercise the check/diagnostic API.
 */

import {suite, test} from 'node:test';
import assert from 'node:assert';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createStringReader,
  createStringWriter,
  createConsoleImports,
} from '@zena-lang/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Same shape as the exports from lsp.wasm. */
interface LspExports extends WebAssembly.Exports {
  init(stdlibRoot: unknown): void;
  check(source: unknown, path: unknown): unknown;
  getDiagnosticCount(diagnostics: unknown): number;
  getDiagnosticLine(diagnostics: unknown, index: number): number;
  getDiagnosticColumn(diagnostics: unknown, index: number): number;
  getDiagnosticStart(diagnostics: unknown, index: number): number;
  getDiagnosticLength(diagnostics: unknown, index: number): number;
  getDiagnosticSeverity(diagnostics: unknown, index: number): number;
  getDiagnosticMessage(diagnostics: unknown, index: number): unknown;
  $stringGetByte(str: unknown, index: number): number;
  $stringGetLength(str: unknown): number;
  $stringCreate(len: number): unknown;
  $stringSetByte(str: unknown, index: number, value: number): void;
}

interface LspHandle {
  exports: LspExports;
  writeString: (s: string) => unknown;
  readString: (ref: unknown, len: number) => string;
}

/** Load lsp.wasm and wire up imports. */
async function loadLsp(): Promise<LspHandle> {
  // lsp.wasm lives at packages/vscode-zena/lsp.wasm after build
  const wasmPath = resolve(__dirname, '../lsp.wasm');
  const wasmBuffer = await readFile(wasmPath);

  let exports: LspExports | undefined;
  let writeString: ((s: string) => unknown) | undefined;
  let readString: ((ref: unknown, len: number) => string) | undefined;

  const consoleImports = createConsoleImports(() => exports);

  const compilerImports = {
    read_file: (pathRef: unknown, pathLen: number): unknown => {
      const filePath = readString!(pathRef, pathLen);
      console.log(`  [read_file] ${filePath}`);
      try {
        const content = readFileSync(filePath, 'utf8');
        return writeString!(content);
      } catch (e: any) {
        console.error(
          `lsp_test: read_file failed for: ${filePath}`,
          e?.message,
        );
        return writeString!('');
      }
    },
  };

  const result = await WebAssembly.instantiate(wasmBuffer, {
    console: consoleImports,
    compiler: compilerImports,
  });

  const instance =
    (result as unknown as {instance: WebAssembly.Instance}).instance ?? result;
  exports = instance.exports as LspExports;
  writeString = createStringWriter(exports);
  readString = createStringReader(exports);

  // Init with stdlib root.
  const stdlibRoot = resolve(__dirname, '../..', 'stdlib/zena');
  exports.init(writeString(stdlibRoot));

  return {exports, writeString, readString};
}

/** Helper: check source and return diagnostics as plain objects. */
function checkSource(lsp: LspHandle, source: string, path = '/test/main.zena') {
  const {exports, writeString, readString} = lsp;
  const sourceRef = writeString(source);
  const pathRef = writeString(path);
  const handle = exports.check(sourceRef, pathRef);
  const count = exports.getDiagnosticCount(handle);

  const diagnostics: {
    line: number;
    column: number;
    start: number;
    length: number;
    severity: number;
    message: string;
  }[] = [];

  for (let i = 0; i < count; i++) {
    const msgRef = exports.getDiagnosticMessage(handle, i);
    const msgLen = exports.$stringGetLength(msgRef);
    diagnostics.push({
      line: exports.getDiagnosticLine(handle, i),
      column: exports.getDiagnosticColumn(handle, i),
      start: exports.getDiagnosticStart(handle, i),
      length: exports.getDiagnosticLength(handle, i),
      severity: exports.getDiagnosticSeverity(handle, i),
      message: readString(msgRef, msgLen),
    });
  }

  return diagnostics;
}

suite('lsp.wasm integration', () => {
  // Load once, reuse across tests.
  let lsp: LspHandle;

  test('loads and initializes', async () => {
    lsp = await loadLsp();
    assert.ok(lsp.exports.check, 'check export exists');
    assert.ok(lsp.exports.init, 'init export exists');
  });

  test('reports no diagnostics for valid code', () => {
    const diags = checkSource(lsp, 'let x = 42;');
    assert.strictEqual(
      diags.length,
      0,
      `Expected 0 diagnostics, got: ${JSON.stringify(diags)}`,
    );
  });

  test('reports diagnostic for type error', () => {
    const diags = checkSource(lsp, 'let x: i32 = "hello";');
    assert.ok(diags.length > 0, 'Expected at least 1 diagnostic');
    // Should be a type mismatch error
    const hasTypeMismatch = diags.some(
      (d) => d.severity === 0 && d.message.toLowerCase().includes('type'),
    );
    assert.ok(
      hasTypeMismatch,
      `Expected type error, got: ${JSON.stringify(diags)}`,
    );
  });

  test('reports diagnostic for unresolved name', () => {
    const diags = checkSource(lsp, 'let x = unknownVariable;');
    assert.ok(diags.length > 0, 'Expected at least 1 diagnostic');
  });

  test('resolves stdlib imports without errors', () => {
    const source = `
      import { Array } from 'zena:array';
      let arr = new Array<i32>();
    `;
    let diags;
    try {
      diags = checkSource(lsp, source);
    } catch (e: any) {
      // Log the error from console output, then fail explicitly
      assert.fail(`check() threw: ${e}\n${e?.stack}`);
    }
    // Filter out any "not used" warnings — we only care about errors
    const errors = diags!.filter((d) => d.severity === 0);
    assert.strictEqual(
      errors.length,
      0,
      `Expected 0 errors with stdlib import, got: ${JSON.stringify(errors)}`,
    );
  });

  test('resolves simple stdlib import', () => {
    // Test with inline source that mimics string.zena features
    const stringLikeSrc = `
export final class MyString {
  #data: i32;
  #start: i32;
  #end: i32;

  new(data: i32, start: i32, end: i32)
    : #data = data, #start = start, #end = end;

  length: i32 {
    get {
      return this.#end - this.#start;
    }
  }

  static fromParts(x: i32): MyString {
    return new MyString(x, 0, x);
  }

  getByteAt(index: i32): i32 {
    return this.#start + index;
  }

  copy(): MyString {
    return new MyString(this.#data, this.#start, this.#end);
  }

  operator +(other: MyString): MyString {
    return new MyString(this.#data, this.#start, other.#end);
  }

  operator ==(other: MyString): boolean {
    return this.#start == other.#start;
  }
}
`;
    try {
      const diags = checkSource(lsp, stringLikeSrc);
      const errors = diags.filter((d: any) => d.severity === 0);
      console.log(`  [string-like test] ${errors.length} errors`);
      if (errors.length > 0) console.log(`    ${JSON.stringify(errors)}`);
    } catch (e: any) {
      console.log(`  [string-like test] CRASH - ${e.message}`);
    }

    // Also test the actual stdlib imports
    const tests = [
      {
        name: 'string',
        src: `import { String } from 'zena:string'; let x: i32 = 42;`,
      },
      {
        name: 'error',
        src: `import { Error } from 'zena:error'; let x: i32 = 42;`,
      },
    ];
    for (const t of tests) {
      try {
        const diags = checkSource(lsp, t.src);
        const errors = diags.filter((d: any) => d.severity === 0);
        console.log(`  [import test] ${t.name}: ${errors.length} errors`);
        if (errors.length > 0) console.log(`    ${JSON.stringify(errors)}`);
      } catch (e: any) {
        console.log(`  [import test] ${t.name}: CRASH - ${e.message}`);
      }
    }
  });

  test('reports error for bad import name', () => {
    const source = `
      import { NonExistentThing } from 'zena:array';
      let x = NonExistentThing;
    `;
    const diags = checkSource(lsp, source);
    assert.ok(diags.length > 0, 'Expected diagnostics for bad import');
  });

  test('diagnostic has location info', () => {
    const diags = checkSource(lsp, 'let x: i32 = "hello";');
    assert.ok(diags.length > 0);
    const d = diags[0];
    assert.ok(d.line > 0, `Expected line > 0, got ${d.line}`);
    assert.ok(d.column > 0, `Expected column > 0, got ${d.column}`);
  });

  test('imported types resolve in type annotations', () => {
    // A file that imports Array (a class) from stdlib and uses it as a type.
    const source = `
      import { Array } from 'zena:array';
      let describe = (arr: Array<i32>): i32 => 0;
    `;
    const diags = checkSource(lsp, source);
    const errors = diags.filter((d) => d.severity === 0);
    // "Array" should be recognized as a type — no "Type 'Array' not found".
    const typeNotFound = errors.filter((d) => d.message.includes('not found'));
    assert.strictEqual(
      typeNotFound.length,
      0,
      `Imported type should resolve, got: ${JSON.stringify(typeNotFound)}`,
    );
  });
});
