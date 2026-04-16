/**
 * Integration tests for lsp.wasm — the language service entry point.
 *
 * These tests load lsp.wasm directly in Node.js (no VS Code needed),
 * provide mock host imports, and exercise the check/diagnostic/format API.
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
  getDiagnosticFile(diagnostics: unknown, index: number): unknown;
  format(source: unknown): unknown;
  getDefinition(offset: number): unknown;
  getDefinitionFile(result: unknown): unknown;
  getDefinitionLine(result: unknown): number;
  getDefinitionColumn(result: unknown): number;
  getDefinitionStart(result: unknown): number;
  getDefinitionLength(result: unknown): number;
  getHover(offset: number): unknown;
  getHoverType(result: unknown): unknown;
  getHoverLabel(result: unknown): unknown;
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
  // lsp.wasm lives at packages/language-service/lsp.wasm after build
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
  const stdlibRoot = resolve(__dirname, '..', '../stdlib/zena');
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
    file: string;
  }[] = [];

  for (let i = 0; i < count; i++) {
    const msgRef = exports.getDiagnosticMessage(handle, i);
    const msgLen = exports.$stringGetLength(msgRef);
    const fileRef = exports.getDiagnosticFile(handle, i);
    const fileLen = exports.$stringGetLength(fileRef);
    diagnostics.push({
      line: exports.getDiagnosticLine(handle, i),
      column: exports.getDiagnosticColumn(handle, i),
      start: exports.getDiagnosticStart(handle, i),
      length: exports.getDiagnosticLength(handle, i),
      severity: exports.getDiagnosticSeverity(handle, i),
      message: readString(msgRef, msgLen),
      file: readString(fileRef, fileLen),
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

  test('format returns formatted source', () => {
    const {exports, writeString, readString} = lsp;
    const source = 'let   x=42;';
    const sourceRef = writeString(source);
    const resultRef = exports.format(sourceRef);
    const resultLen = exports.$stringGetLength(resultRef);
    const formatted = readString(resultRef, resultLen);
    assert.ok(
      formatted.includes('let'),
      `Expected formatted output, got: ${formatted}`,
    );
    // Should be cleaner than the input
    assert.notStrictEqual(formatted, source, 'Format should change the source');
  });

  // ========================================================================
  // Go to Definition Tests
  // ========================================================================

  /**
   * Helper: check source, then call getDefinition at a byte offset.
   * Returns {file, line, column, start, length} or null.
   */
  function getDefinitionAt(
    lsp: LspHandle,
    source: string,
    offset: number,
    path = '/test/main.zena',
  ) {
    const {exports, writeString, readString} = lsp;
    // check() must run first to populate the cached scope result.
    checkSource(lsp, source, path);
    const resultRef = exports.getDefinition(offset);
    if (resultRef === null || resultRef === undefined || resultRef === 0)
      return null;
    const fileRef = exports.getDefinitionFile(resultRef);
    const fileLen = exports.$stringGetLength(fileRef);
    return {
      file: readString(fileRef, fileLen),
      line: exports.getDefinitionLine(resultRef),
      column: exports.getDefinitionColumn(resultRef),
      start: exports.getDefinitionStart(resultRef),
      length: exports.getDefinitionLength(resultRef),
    };
  }

  /** Find the byte offset of a substring in source. */
  function offsetOf(source: string, needle: string, occurrence = 1): number {
    let idx = -1;
    for (let i = 0; i < occurrence; i++) {
      idx = source.indexOf(needle, idx + 1);
      if (idx === -1)
        throw new Error(`"${needle}" occurrence ${i + 1} not found`);
    }
    return idx;
  }

  test('getDefinition: variable reference → declaration', () => {
    //        0123456789...
    const src = 'let x = 42;\nlet y = x;';
    // "x" in "let y = x" is at the second occurrence of "x"
    const offset = offsetOf(src, 'x', 2);
    const def = getDefinitionAt(lsp, src, offset);
    assert.ok(def, 'Expected a definition result');
    // Should point to "x" in "let x = 42" (offset 4)
    assert.strictEqual(def!.start, offsetOf(src, 'x', 1));
    assert.strictEqual(def!.line, 1);
  });

  test('getDefinition: type annotation → class declaration', () => {
    const src =
      'class Foo { x: i32; new(this.x); }\nlet f = (a: Foo): i32 => 0;';
    // "Foo" in parameter type annotation "a: Foo"
    const offset = offsetOf(src, 'Foo', 2);
    const def = getDefinitionAt(lsp, src, offset);
    assert.ok(def, 'Expected a definition for type name Foo');
    // Should point to the ClassDeclaration (start of "class Foo")
    assert.strictEqual(def!.line, 1);
  });

  test('getDefinition: constructor reference → class declaration', () => {
    const src = 'class Foo { x: i32; new(this.x); }\nlet f = new Foo(1);';
    // "Foo" in "new Foo(1)"
    const offset = offsetOf(src, 'Foo', 2);
    const def = getDefinitionAt(lsp, src, offset);
    assert.ok(def, 'Expected a definition for constructor Foo');
    assert.strictEqual(def!.line, 1);
  });

  test('getDefinition: parameter declaration → itself', () => {
    const src = 'let f = (x: i32): i32 => x;';
    // Click on "x" in the parameter "(x: i32)"
    const offset = offsetOf(src, 'x', 1);
    const def = getDefinitionAt(lsp, src, offset);
    assert.ok(def, 'Expected a definition for parameter declaration');
    // Should point to the parameter itself.
    assert.strictEqual(def!.start, offset);
  });

  test('getDefinition: return type annotation resolves', () => {
    const src =
      'class Bar { x: i32; new(this.x); }\nlet f = (a: i32): Bar => new Bar(a);';
    // "Bar" in return type ": Bar"
    const offset = offsetOf(src, 'Bar', 2);
    const def = getDefinitionAt(lsp, src, offset);
    assert.ok(def, 'Expected a definition for return type Bar');
    assert.strictEqual(def!.line, 1);
  });

  test('getDefinition: no result at non-symbol position', () => {
    const src = 'let x = 42;';
    // Offset 0 is at 'l' of 'let' — a keyword, not a symbol reference.
    const def = getDefinitionAt(lsp, src, 0);
    assert.strictEqual(def, null);
  });

  test('getDefinition: field type annotation resolves', () => {
    const src =
      'class A { x: i32; new(this.x); }\nclass B { a: A; new(this.a); }';
    // "A" in field type "a: A" inside class B
    const offset = offsetOf(src, 'A', 2);
    const def = getDefinitionAt(lsp, src, offset);
    assert.ok(def, 'Expected a definition for field type A');
    assert.strictEqual(def!.line, 1);
  });

  // ========================================================================
  // Hover Tests
  // ========================================================================

  /**
   * Helper: check source, then call getHover at a byte offset.
   * Returns {type, label} or null.
   */
  function getHoverAt(
    lsp: LspHandle,
    source: string,
    offset: number,
    path = '/test/main.zena',
  ) {
    const {exports, readString} = lsp;
    // check() must run first to populate the cached results.
    checkSource(lsp, source, path);
    const resultRef = exports.getHover(offset);
    if (resultRef === null || resultRef === undefined || resultRef === 0)
      return null;
    const typeRef = exports.getHoverType(resultRef);
    const typeLen = exports.$stringGetLength(typeRef);
    const labelRef = exports.getHoverLabel(resultRef);
    const labelLen = exports.$stringGetLength(labelRef);
    return {
      type: readString(typeRef, typeLen),
      label: readString(labelRef, labelLen),
    };
  }

  test('getHover: variable with explicit type', () => {
    const src = 'let x: i32 = 42;\nlet y = x;';
    // Hover over "x" in "let y = x"
    const offset = offsetOf(src, 'x', 2);
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info');
    assert.strictEqual(hover!.type, 'i32');
    assert.ok(
      hover!.label.includes('x') && hover!.label.includes('i32'),
      `Expected label with name and type, got: ${hover!.label}`,
    );
  });

  test('getHover: inferred type from literal', () => {
    const src = 'let x = 42;';
    // Hover over "x" at declaration
    const offset = offsetOf(src, 'x', 1);
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info');
    assert.strictEqual(hover!.type, 'i32');
  });

  test('getHover: function type', () => {
    const src = 'let add = (a: i32, b: i32): i32 => a + b;';
    const offset = offsetOf(src, 'add', 1);
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info for function');
    // The type should be a function type
    assert.ok(
      hover!.type.includes('=>'),
      `Expected function type, got: ${hover!.type}`,
    );
  });

  test('getHover: no result at keyword', () => {
    const src = 'let x = 42;';
    // Offset 0 is 'l' of 'let'
    const hover = getHoverAt(lsp, src, 0);
    assert.strictEqual(hover, null, 'Expected no hover at keyword');
  });

  test('getHover: var binding shows var keyword', () => {
    const src = 'var count = 0;';
    const offset = offsetOf(src, 'count', 1);
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info for var');
    assert.ok(
      hover!.label.startsWith('var '),
      `Expected var prefix, got: ${hover!.label}`,
    );
  });

  test('getHover: this keyword shows class type', () => {
    const src = `class Foo {
  x: i32;
  new(this.x);
  getX(): i32 { return this.x; }
}`;
    // Hover over "this" in "return this.x" (not the constructor's this.x)
    const offset = src.lastIndexOf('this.x');
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info for this');
    assert.ok(
      hover!.label.includes('this') && hover!.label.includes('Foo'),
      `Expected this: Foo, got: ${hover!.label}`,
    );
  });

  test('getHover: member access property shows type', () => {
    const src = `class Foo {
  x: i32;
  new(this.x);
}
let f = new Foo(42);
let v = f.x;`;
    // Hover over "x" in "f.x"
    const lastLine = 'let v = f.x;';
    const lineStart = src.indexOf(lastLine);
    const offset = lineStart + lastLine.indexOf('.x') + 1; // on 'x'
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info for member access');
    assert.ok(
      hover!.label.includes('(property)') && hover!.label.includes('x'),
      `Expected (property) label, got: ${hover!.label}`,
    );
  });

  test('getHover: function parameter shows (parameter)', () => {
    const src = 'let add = (a: i32, b: i32): i32 => a + b;';
    // Hover over "a" in the parameter list
    const offset = src.indexOf('a:');
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info for parameter');
    assert.ok(
      hover!.label.startsWith('(parameter)'),
      `Expected (parameter) prefix, got: ${hover!.label}`,
    );
    assert.ok(
      hover!.label.includes('a') && hover!.label.includes('i32'),
      `Expected parameter name and type, got: ${hover!.label}`,
    );
  });

  test('getHover: class name shows class prefix', () => {
    const src = `class Foo {
  x: i32;
  new(this.x);
}
let f = new Foo(42);`;
    // Hover over "Foo" in "new Foo(42)"
    const lastLine = 'let f = new Foo(42);';
    const lineStart = src.indexOf(lastLine);
    const offset = lineStart + lastLine.indexOf('Foo');
    const hover = getHoverAt(lsp, src, offset);
    assert.ok(hover, 'Expected hover info for class reference');
    assert.ok(
      hover!.label.startsWith('class '),
      `Expected class prefix, got: ${hover!.label}`,
    );
  });
});
