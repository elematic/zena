/**
 * Tests for the JavaScript API wrapping lsp.wasm.
 *
 * `lsp_test.ts` covers the Wasm exports directly; this covers the wrapper the
 * playground and other embedders actually use, running it in Node against the
 * real stdlib on disk.
 */

import {suite, test, before} from 'node:test';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createLanguageService,
  createVirtualFileReader,
  type ZenaLanguageService,
} from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '../lsp.wasm');
const stdlibRoot = resolve(__dirname, '../../stdlib/zena');

const PATH = '/test/main.zena';

suite('language service API', () => {
  let service: ZenaLanguageService;
  const logs: string[] = [];
  /** Files the reader serves that are not on disk. */
  const virtualFiles = new Map<string, string>();

  before(async () => {
    const wasm = await readFile(wasmPath);
    service = await createLanguageService({
      wasm,
      stdlibRoot,
      readFile: (path) => {
        if (virtualFiles.has(path)) {
          return virtualFiles.get(path);
        }
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return undefined;
        }
      },
      console: {log: (message) => logs.push(message)},
    });
  });

  test('accepts valid source', () => {
    assert.deepStrictEqual(service.check(PATH, 'let _x = 42;'), []);
  });

  test('reports type errors with a position', () => {
    const diagnostics = service.check(PATH, 'let x: i32 = "hello";');
    const error = diagnostics.find((d) => d.severity === 'error');
    assert.ok(error, `expected an error in ${JSON.stringify(diagnostics)}`);
    assert.strictEqual(error.file, PATH);
    assert.strictEqual(error.line, 1);
    assert.match(error.message, /not assignable/);
    // The unused-variable warning rides along, so severity is per-diagnostic.
    assert.ok(diagnostics.some((d) => d.severity === 'warning'));
  });

  test('resolves stdlib imports through the stdlib root', () => {
    const diagnostics = service.check(
      PATH,
      `import {OrderedMap} from 'zena:ordered-map';\nlet _m = new OrderedMap<String, i32>();\n`,
    );
    assert.deepStrictEqual(diagnostics, []);
  });

  // A clean program must check clean all the way down. A warning in a
  // module it merely imports is still reported, with that module's `file`
  // and its line numbers — an embedder with one open document has nowhere
  // sensible to put it, so it lands on the wrong file's last line.
  test('a program awaiting zena:time reports nothing, in any file', () => {
    const diagnostics = service.check(
      PATH,
      `import {sleep} from 'zena:time';\n` +
        `export async function main() {\n` +
        `  await sleep(1);\n` +
        `}\n`,
    );
    assert.deepStrictEqual(diagnostics, []);
  });

  test('reports hover type information', () => {
    const source = 'let greeting = 42;\nlet other = greeting;\n';
    const hover = service.hover(PATH, source.indexOf('greeting;') + 1, source);
    assert.ok(hover, 'expected hover info');
    assert.ok(
      `${hover.label}${hover.type}`.includes('i32'),
      `expected an i32 in ${JSON.stringify(hover)}`,
    );
  });

  test('proposes completions', () => {
    const source = 'let s = "hello";\nlet _n = s.';
    const items = service.completions(PATH, source.length, source);
    assert.ok(items.length > 0, 'expected completions');
    assert.ok(
      items.some((item) => item.label === 'startsWith'),
      'expected String members among the proposals',
    );
  });

  test('returns a document outline', () => {
    const symbols = service.documentSymbols(
      PATH,
      'class Point {\n  x: f64;\n  new(this.x);\n}\n',
    );
    assert.ok(symbols.length > 0, 'expected symbols');
    assert.strictEqual(symbols[0].name, 'Point');
  });

  test('compiles to a WebAssembly binary', () => {
    const bytes = service.compileToWasm(
      PATH,
      'export let main = (): i32 => 42;\n',
    );
    assert.ok(bytes, 'expected a binary');
    // \0asm
    assert.deepStrictEqual([...bytes.slice(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  });

  test('routes console output to the sink', () => {
    logs.length = 0;
    const bytes = service.compileToWasm(
      PATH,
      `export let main = () => {\n  console.log('from zena');\n};\n`,
    );
    assert.ok(bytes, 'expected a binary');
    // The sink is wired to the *service* instance, so nothing should arrive
    // from compiling alone — running the program is the embedder's job.
    assert.deepStrictEqual(logs, []);
  });

  test('formats source', () => {
    const formatted = service.format('let    x=1;');
    assert.ok(formatted.includes('let x = 1;'), formatted);
  });

  test('an open document shadows the file reader until closed', () => {
    const path = '/virtual/only.zena';
    virtualFiles.set(path, 'let x: i32 = "from disk";');

    service.openDocument(path, 'let _ok = 1;');
    assert.deepStrictEqual(service.check(path), []);

    service.closeDocument(path);
    assert.ok(
      service.check(path).some((d) => d.severity === 'error'),
      'expected the reader’s copy to be checked once the document was closed',
    );
  });

  test('closing an imported document invalidates cache and reports missing module error', () => {
    const mathPath = '/test/math.zena';
    const mainPath = '/test/main_import.zena';

    service.openDocument(
      mathPath,
      'export let add = (a: i32, b: i32): i32 => a + b;',
    );
    const diagsBefore = service.check(
      mainPath,
      "import { add } from './math.zena';\nexport let main = () => add(1, 2);",
    );
    assert.deepStrictEqual(diagsBefore, []);

    service.closeDocument(mathPath);
    const diagsAfter = service.check(
      mainPath,
      "import { add } from './math.zena';\nexport let main = () => add(1, 2);",
    );
    assert.ok(
      diagsAfter.some(
        (d) =>
          d.severity === 'error' &&
          d.line === 1 &&
          d.message.includes("Module not found: './math.zena'"),
      ),
      `Expected Module not found error on line 1, got: ${JSON.stringify(diagsAfter)}`,
    );

    const bytes = service.compileToWasm(
      mainPath,
      "import { add } from './math.zena';\nexport let main = () => add(1, 2);",
    );
    assert.strictEqual(
      bytes,
      null,
      'compileToWasm should return null when dependency is missing',
    );
  });
});

suite('createVirtualFileReader', () => {
  const files = {
    '/stdlib/string.zena': 'string source',
    '/stdlib/collections/index.zena': 'collections source',
  };
  const read = createVirtualFileReader(files);

  test('finds an exact path', () => {
    assert.strictEqual(read('/stdlib/string.zena'), 'string source');
  });

  test('adds a missing leading slash', () => {
    assert.strictEqual(read('stdlib/string.zena'), 'string source');
  });

  test('maps a zena: specifier under the stdlib root', () => {
    assert.strictEqual(read('zena:string'), 'string source');
  });

  test('falls back to a directory index', () => {
    assert.strictEqual(read('zena:collections'), 'collections source');
  });

  test('returns undefined for an unknown path', () => {
    assert.strictEqual(read('/nope.zena'), undefined);
  });
});
