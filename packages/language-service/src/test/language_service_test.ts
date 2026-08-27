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
import {instantiate, run, createStringReader} from '@zena-lang/runtime';

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

  test('reports exactly one error for an illegal union type alias', () => {
    const diagnostics = service.check(PATH, 'type U = String | i32;\n');
    const errors = diagnostics.filter((d) => d.severity === 'error');
    assert.strictEqual(
      errors.length,
      1,
      `expected exactly 1 error in ${JSON.stringify(diagnostics)}`,
    );
    assert.strictEqual(errors[0].line, 1);
    assert.match(
      errors[0].message,
      /cannot mix primitive types with reference types/,
    );
  });

  test('reports errors for both earlier statements and illegal union aliases', () => {
    const diagnostics = service.check(
      PATH,
      'let _x: i32 = "hello";\ntype U = String | i32;\n',
    );
    const errors = diagnostics.filter((d) => d.severity === 'error');
    assert.strictEqual(
      errors.length,
      2,
      `expected exactly 2 errors in ${JSON.stringify(diagnostics)}`,
    );
    assert.strictEqual(errors[0].line, 1);
    assert.match(errors[0].message, /not assignable/);
    assert.strictEqual(errors[1].line, 2);
    assert.match(
      errors[1].message,
      /cannot mix primitive types with reference types/,
    );
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

  test('runs snippet with top-level records and tuples', async () => {
    const source = `// Records are anonymous structures of named fields:
let origin = {x: 10.0, y: 20.0};

// Tuples are anonymous, ordered sets of values:
let point = (10.0, 20.0);

export let main = () => {
  console.log(\`x = \${origin.x}, y = \${origin.y}\`);
  console.log(\`p[0] = \${point[0]}, p[1] = \${point[1]}\`);
};
`;
    const docPath = 'main.zena';
    service.openDocument(docPath, source);
    const diags = service.check(docPath, source);
    assert.strictEqual(
      diags.length,
      0,
      `Unexpected diagnostics: ${JSON.stringify(diags)}`,
    );
    const bytes = service.compileToWasm(docPath, source);
    assert.ok(bytes, 'expected a binary');
    let programExports: WebAssembly.Exports | undefined;
    const output: string[] = [];
    const result = await instantiate(bytes, {
      console: {
        log_string: (strRef: unknown, length: number) => {
          const reader = createStringReader(programExports!);
          output.push(reader(strRef, length));
        },
      },
    });
    const instance = 'instance' in result ? result.instance : result;
    programExports = instance.exports;
    await run(instance);
    assert.deepStrictEqual(output, ['x = 10, y = 20', 'p[0] = 10, p[1] = 20']);
  });

  test('test basic mixin', async () => {
    const source = `mixin M {
  foo(): i32 {
    return 42;
  }
}

class C with M {
  new();
}

export let main = (): i32 => {
  let c = new C();
  return c.foo();
};
`;
    const docPath = 'basic_mixin.zena';
    service.openDocument(docPath, source);
    const diags = service
      .check(docPath, source)
      .filter((d) => d.severity === 'error');
    assert.strictEqual(
      diags.length,
      0,
      `Unexpected diagnostics: ${JSON.stringify(diags)}`,
    );
    const bytes = service.compileToWasm(docPath, source);
    assert.ok(bytes, 'expected a binary');
  });

  test('website mixins and interfaces example', async () => {
    const source = `interface Animal {
  speak(): void;
}

mixin Friendly {
  greet(name: String): void {
    console.log(\`Hello, \${name}!\`);
  }
}

class Dog with Friendly implements Animal {
  speak(): void {
    console.log('Woof');
  }
}

export let main = () => {
  let dog = new Dog();
  dog.speak();
  dog.greet('Zena');
};
`;
    const docPath = 'dog_friendly.zena';
    service.openDocument(docPath, source);
    const diags = service
      .check(docPath, source)
      .filter((d) => d.severity === 'error');
    assert.strictEqual(
      diags.length,
      0,
      `Unexpected diagnostics: ${JSON.stringify(diags)}`,
    );
    const bytes = service.compileToWasm(docPath, source);
    assert.ok(bytes, 'expected a binary');
  });

  test('website sealed classes example', async () => {
    const source = `sealed class Expr {
  case Lit(value: i32)
  case Add(left: Expr, right: Expr)
  case Neg(operand: Expr)
}

let eval = (e: Expr): i32 => match (e) {
  case Lit {value}: value
  case Add {left, right}: eval(left) + eval(right)
  case Neg {operand}: -eval(operand)
};

export let main = () => {
  let expr = new Add(new Lit(2), new Neg(new Lit(5)));
  console.log(\`\${eval(expr)}\`);
};
`;
    const docPath = 'sealed_classes.zena';
    service.openDocument(docPath, source);
    const diags = service
      .check(docPath, source)
      .filter((d) => d.severity === 'error');
    assert.strictEqual(
      diags.length,
      0,
      `Unexpected diagnostics: ${JSON.stringify(diags)}`,
    );
    const bytes = service.compileToWasm(docPath, source);
    assert.ok(bytes, 'expected a binary');
  });

  test('website pattern matching example', async () => {
    const source = `sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
}

// Guards run after the pattern matches; \`_\` is the wildcard.
let describe = (shape: Shape): String => match (shape) {
  case Circle {radius} if radius > 10.0: 'a large circle'
  case Circle: 'a circle'
  case Rect {width, height} if width == height: 'a square'
  case _: 'a rectangle'
};

export let main = () => {
  console.log(describe(new Circle(20.0)));
  console.log(describe(new Circle(5.0)));
  console.log(describe(new Rect(3.0, 3.0)));
  console.log(describe(new Rect(4.0, 5.0)));
};
`;
    const docPath = 'pattern_matching.zena';
    service.openDocument(docPath, source);
    const diags = service
      .check(docPath, source)
      .filter((d) => d.severity === 'error');
    assert.strictEqual(
      diags.length,
      0,
      `Unexpected diagnostics: ${JSON.stringify(diags)}`,
    );
    const bytes = service.compileToWasm(docPath, source);
    assert.ok(bytes, 'expected a binary');
  });

  test('website modules example (multi-file)', async () => {
    const mathSource = `export let add = (a: i32, b: i32): i32 => a + b;
export let greet = (name: String): String => {
  return 'Hello ' + name + '!';
};
`;
    const mainSource = `import { add, greet } from './math.zena';

export let main = () => {
  console.log(greet('Zena Developer'));
  console.log(\`1 + 2 = \${add(1, 2)}\`);
};
`;
    service.openDocument('math.zena', mathSource);
    service.openDocument('main.zena', mainSource);
    const diags = service
      .check('main.zena', mainSource)
      .filter((d) => d.severity === 'error');
    assert.strictEqual(
      diags.length,
      0,
      `Unexpected diagnostics: ${JSON.stringify(diags)}`,
    );
    const bytes = service.compileToWasm('main.zena', mainSource);
    assert.ok(bytes, 'expected a binary');
  });

  test('test interface only', async () => {
    const source = `interface Animal {
  speak(): void;
}

class Dog implements Animal {
  speak(): void {
    console.log('Woof');
  }
}

export let main = () => {
  let dog = new Dog();
  dog.speak();
};
`;
    const docPath = 'interface_only.zena';
    service.openDocument(docPath, source);
    const diags = service
      .check(docPath, source)
      .filter((d) => d.severity === 'error');
    assert.strictEqual(
      diags.length,
      0,
      `Unexpected diagnostics: ${JSON.stringify(diags)}`,
    );
    const bytes = service.compileToWasm(docPath, source);
    assert.ok(bytes, 'expected a binary');
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
