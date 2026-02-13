/**
 * Tests for the WIT parser.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Compiler, CodeGenerator} from '@zena-lang/compiler';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to stdlib
const stdlibPath = join(__dirname, '../../stdlib/zena');

// Path to wit-parser zena files
const witParserPath = join(__dirname, '../zena');

/**
 * Create a compiler host for wit-parser modules.
 */
const createHost = () => ({
  load: (p: string): string => {
    // Handle wit-parser local imports
    if (p.startsWith('/wit-parser/')) {
      const name = p.substring('/wit-parser/'.length);
      return readFileSync(join(witParserPath, name), 'utf-8');
    }

    // Handle stdlib imports
    if (p.startsWith('zena:')) {
      const name = p.substring(5);
      return readFileSync(join(stdlibPath, `${name}.zena`), 'utf-8');
    }

    throw new Error(`File not found: ${p}`);
  },
  resolve: (specifier: string, referrer: string): string => {
    // Local imports from wit-parser modules
    if (specifier.startsWith('./') && referrer.startsWith('/wit-parser/')) {
      return '/wit-parser/' + specifier.substring(2);
    }

    if (specifier === 'zena:console') {
      return 'zena:console-host';
    }

    return specifier;
  },
});

/**
 * Compile a wit-parser module.
 */
const compileModule = (moduleName: string) => {
  const host = createHost();
  const compiler = new Compiler(host);
  const entryPoint = `/wit-parser/${moduleName}`;
  const modules = compiler.compile(entryPoint);

  const errors = modules.flatMap((m) => m.diagnostics ?? []);
  if (errors.length > 0) {
    const formatted = errors.map((e) => {
      const loc = e.location
        ? `${e.location.file}:${e.location.line}:${e.location.column}: `
        : '';
      return `  ${loc}${e.message}`;
    });
    throw new Error(`Compilation failed:\n${formatted.join('\n')}`);
  }

  const generator = new CodeGenerator(
    modules,
    entryPoint,
    compiler.semanticContext,
    compiler.checkerContext,
  );
  return generator.generate();
};

/**
 * Instantiate the parser test harness with input.
 */
const instantiateParserHarness = async (inputString: string) => {
  const wasm = compileModule('parser-test-harness.zena');
  const inputBytes = new TextEncoder().encode(inputString);

  const imports = {
    input: {
      getLength: () => inputBytes.length,
      getByte: (index: number) => inputBytes[index] ?? 0,
    },
    console: {
      log_i32: () => {},
      log_f32: () => {},
      log_f64: () => {},
      log_string: () => {},
      error_string: () => {},
      warn_string: () => {},
      info_string: () => {},
      debug_string: () => {},
    },
  };

  const result = await WebAssembly.instantiate(
    wasm as BufferSource,
    imports as WebAssembly.Imports,
  );
  const instance = (result as unknown as {instance: WebAssembly.Instance})
    .instance;
  const exports = instance.exports as unknown as {
    parse: () => void;
    countItems: () => number;
    getOutputLength: () => number;
    getOutputByte: (index: number) => number;
  };

  const readOutput = () => {
    const len = exports.getOutputLength();
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = exports.getOutputByte(i);
    }
    return new TextDecoder().decode(bytes);
  };

  return {
    parse: () => {
      exports.parse();
      return readOutput();
    },
    countItems: () => exports.countItems(),
  };
};

suite('WIT Parser', () => {
  test('parser.zena compiles', () => {
    const wasm = compileModule('parser.zena');
    assert.ok(wasm.length > 0, 'Should produce WASM output');
    console.log(`    parser.zena: ${wasm.length} bytes`);
  });

  test('parser-test-harness.zena compiles', () => {
    const wasm = compileModule('parser-test-harness.zena');
    assert.ok(wasm.length > 0, 'Should produce WASM output');
    console.log(`    parser-test-harness.zena: ${wasm.length} bytes`);
  });

  test('parses empty input', async () => {
    const harness = await instantiateParserHarness('');
    const count = harness.countItems();
    assert.strictEqual(count, 0);
  });

  test('parses empty interface', async () => {
    const harness = await instantiateParserHarness('interface empty {}');
    const output = harness.parse();
    assert.match(output, /interface empty/);
    assert.strictEqual(harness.countItems(), 1);
  });

  test('parses interface with function', async () => {
    const harness = await instantiateParserHarness(`
      interface greet {
        hello: func(name: string) -> string;
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface greet/);
    assert.strictEqual(harness.countItems(), 1);
  });

  test('parses package declaration', async () => {
    const harness = await instantiateParserHarness(`
      package wasi:cli@0.2.0;
      
      interface terminal {
        print: func(msg: string);
      }
    `);
    const output = harness.parse();
    assert.match(output, /package: wasi:cli@0\.2\.0/);
    assert.match(output, /interface terminal/);
  });

  test('parses world with imports and exports', async () => {
    const harness = await instantiateParserHarness(`
      world example {
        import printer;
        export run: func();
      }
    `);
    const output = harness.parse();
    assert.match(output, /world example/);
  });

  test('parses record type', async () => {
    const harness = await instantiateParserHarness(`
      interface types {
        record point {
          x: s32,
          y: s32,
        }
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface types/);
  });

  test('parses variant type', async () => {
    const harness = await instantiateParserHarness(`
      interface result-types {
        variant my-result {
          ok(string),
          err(u32),
        }
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface result-types/);
  });

  test('parses enum type', async () => {
    const harness = await instantiateParserHarness(`
      interface colors {
        enum color {
          red,
          green,
          blue,
        }
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface colors/);
  });

  test('parses flags type', async () => {
    const harness = await instantiateParserHarness(`
      interface perms {
        flags permission {
          read,
          write,
          execute,
        }
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface perms/);
  });

  test('parses type alias', async () => {
    const harness = await instantiateParserHarness(`
      interface aliases {
        type my-string = string;
        type my-list = list<u8>;
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface aliases/);
  });

  test('parses resource type', async () => {
    const harness = await instantiateParserHarness(`
      interface files {
        resource file {
          constructor(path: string);
          read: func(len: u64) -> list<u8>;
          write: func(data: list<u8>);
        }
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface files/);
  });

  test('parses use statement in interface', async () => {
    const harness = await instantiateParserHarness(`
      interface consumer {
        use types.{point, size};
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface consumer/);
  });

  test('parses tuple type', async () => {
    const harness = await instantiateParserHarness(`
      interface tuples {
        type pair = tuple<u32, u32>;
        get-pair: func() -> tuple<string, u64>;
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface tuples/);
  });

  test('parses result type', async () => {
    const harness = await instantiateParserHarness(`
      interface results {
        get-value: func() -> result<string, u32>;
        try-get: func() -> result<string>;
        no-error: func() -> result;
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface results/);
  });

  test('parses option type', async () => {
    const harness = await instantiateParserHarness(`
      interface options {
        find: func(key: string) -> option<string>;
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface options/);
  });

  test('reports parse error for invalid input', async () => {
    const harness = await instantiateParserHarness('not valid wit');
    const output = harness.parse();
    assert.match(output, /ParseError/);
  });

  test('parses multiple interfaces', async () => {
    const harness = await instantiateParserHarness(`
      interface one {}
      interface two {}
      interface three {}
    `);
    assert.strictEqual(harness.countItems(), 3);
  });

  test('parses async function', async () => {
    const harness = await instantiateParserHarness(`
      interface async-example {
        do-work: async func() -> string;
      }
    `);
    const output = harness.parse();
    assert.match(output, /interface async-example/);
  });
});
