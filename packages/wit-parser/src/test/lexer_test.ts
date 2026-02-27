/**
 * Tests for the WIT lexer.
 */

import {suite, test} from 'node:test';
import assert from 'node:assert';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Compiler, type CompilerHost} from '@zena-lang/compiler';
import {CodeGenerator} from '@zena-lang/compiler';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to stdlib
const stdlibPath = join(__dirname, '../../stdlib/zena');

// Path to wit-parser zena files
const witParserPath = join(__dirname, '../zena');

/**
 * Token type enum values (must match token.zena).
 */
const TokenType = {
  Whitespace: 0,
  Comment: 1,
  DocComment: 2,
  Equals: 3,
  Comma: 4,
  Colon: 5,
  Period: 6,
  Semicolon: 7,
  LeftParen: 8,
  RightParen: 9,
  LeftBrace: 10,
  RightBrace: 11,
  LessThan: 12,
  GreaterThan: 13,
  RArrow: 14,
  Star: 15,
  At: 16,
  Slash: 17,
  Plus: 18,
  Minus: 19,
  U8: 20,
  U16: 21,
  U32: 22,
  U64: 23,
  S8: 24,
  S16: 25,
  S32: 26,
  S64: 27,
  F32: 28,
  F64: 29,
  Char: 30,
  Bool: 31,
  String: 32,
  Record: 33,
  Flags: 34,
  Variant: 35,
  Enum: 36,
  Option: 37,
  Result: 38,
  List: 39,
  Tuple: 40,
  Future: 41,
  Stream: 42,
  Map: 43,
  Resource: 44,
  Own: 45,
  Borrow: 46,
  Constructor: 47,
  Static: 48,
  Type: 49,
  Func: 50,
  Interface: 51,
  World: 52,
  Package: 53,
  Use: 54,
  As: 55,
  From: 56,
  Import: 57,
  Export: 58,
  Include: 59,
  With: 60,
  Async: 61,
  ErrorContext: 62,
  Underscore: 63,
  Id: 64,
  ExplicitId: 65,
  Integer: 66,
  Eof: 67,
} as const;

/**
 * Create a compiler host for wit-parser modules.
 */
const createHost = (): CompilerHost => ({
  load: (p: string) => {
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
  resolve: (specifier: string, referrer: string) => {
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
const compileModule = (moduleName: string): Uint8Array => {
  const host = createHost();
  const compiler = new Compiler(host);
  const entryPoint = `/wit-parser/${moduleName}`;
  const modules = compiler.compile(entryPoint);

  const errors = modules.flatMap((m) => m.diagnostics ?? []);
  if (errors.length > 0) {
    throw new Error(
      `Compilation failed:\n${errors.map((e) => `  ${e.message}`).join('\n')}`,
    );
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
 * Instantiate the lexer test harness with input.
 */
const instantiateLexerHarness = async (
  inputString: string,
): Promise<WebAssembly.Instance> => {
  const wasm = compileModule('lexer-test-harness.zena');
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
  return (result as unknown as {instance: WebAssembly.Instance}).instance;
};

/**
 * Read output string from instance.
 */
const readOutput = (exports: WebAssembly.Exports): string => {
  const getOutputLength = exports.getOutputLength as () => number;
  const getOutputByte = exports.getOutputByte as (index: number) => number;
  const length = getOutputLength();
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = getOutputByte(i);
  }
  return new TextDecoder().decode(bytes);
};

suite('WIT Lexer', () => {
  test('ast.zena compiles', () => {
    const wasm = compileModule('ast.zena');
    assert.ok(wasm.length > 0, 'Should produce WASM output');
    console.log(`    ast.zena: ${wasm.length} bytes`);
  });

  test('lexer.zena compiles', () => {
    const wasm = compileModule('lexer.zena');
    assert.ok(wasm.length > 0, 'Should produce WASM output');
    console.log(`    lexer.zena: ${wasm.length} bytes`);
  });

  test('lexer-test-harness.zena compiles', () => {
    const wasm = compileModule('lexer-test-harness.zena');
    assert.ok(wasm.length > 0, 'Should produce WASM output');
    console.log(`    lexer-test-harness.zena: ${wasm.length} bytes`);
  });

  test('tokenizes empty input', async () => {
    const instance = await instantiateLexerHarness('');
    const countTokens = instance.exports.countTokens as () => number;
    assert.strictEqual(countTokens(), 0);
  });

  test('tokenizes single punctuation', async () => {
    const instance = await instantiateLexerHarness('=');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Equals);
  });

  test('tokenizes colon', async () => {
    const instance = await instantiateLexerHarness(':');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Colon);
  });

  test('tokenizes right arrow', async () => {
    const instance = await instantiateLexerHarness('->');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.RArrow);
  });

  test('tokenizes keyword', async () => {
    const instance = await instantiateLexerHarness('func');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Func);
  });

  test('tokenizes identifier', async () => {
    const instance = await instantiateLexerHarness('my-func');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Id);
  });

  test('tokenizes explicit identifier', async () => {
    const instance = await instantiateLexerHarness('%bool');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.ExplicitId);
  });

  test('tokenizes integer', async () => {
    const instance = await instantiateLexerHarness('42');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Integer);
  });

  test('tokenizes hex integer', async () => {
    const instance = await instantiateLexerHarness('0xDEAD');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Integer);
  });

  test('skips line comment', async () => {
    const instance = await instantiateLexerHarness('// comment\nfunc');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Func);
  });

  test('skips block comment', async () => {
    const instance = await instantiateLexerHarness('/* comment */func');
    const firstTokenType = instance.exports.firstTokenType as () => number;
    assert.strictEqual(firstTokenType(), TokenType.Func);
  });

  test('counts multiple tokens', async () => {
    const instance = await instantiateLexerHarness('func foo: i32 -> string');
    const countTokens = instance.exports.countTokens as () => number;
    // func, foo, :, i32, ->, string = 6 tokens
    assert.strictEqual(countTokens(), 6);
  });

  test('tokenizes WIT interface snippet', async () => {
    const instance = await instantiateLexerHarness(
      'interface greeter { greet: func(name: string) -> string; }',
    );
    const countTokens = instance.exports.countTokens as () => number;
    // interface, greeter, {, greet, :, func, (, name, :, string, ), ->, string, ;, } = 15 tokens
    assert.strictEqual(countTokens(), 15);
  });

  test('gets first token text', async () => {
    const instance = await instantiateLexerHarness('hello-world');
    const firstTokenText = instance.exports.firstTokenText as () => void;
    firstTokenText();
    const text = readOutput(instance.exports);
    assert.strictEqual(text, 'hello-world');
  });

  test('tokenizes underscore (wildcard)', async () => {
    // Used in WIT for wildcard types like `result<_, error>`
    const instance = await instantiateLexerHarness('result<_, error>');
    const countTokens = instance.exports.countTokens as () => number;
    // result, <, _, ,, error, > = 6 tokens
    assert.strictEqual(countTokens(), 6);
  });
});

/**
 * Find all .wit files recursively in a directory.
 */
const findWitFiles = (dir: string): string[] => {
  const results: string[] = [];

  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.wit')) {
        results.push(full);
      }
    }
  };

  walk(dir);
  return results;
};

suite('WIT Lexer - wasm-tools test files', async () => {
  // Compile the harness once for all tests
  let harnessWasm: Uint8Array;

  test('compiles test harness', () => {
    harnessWasm = compileModule('lexer-test-harness.zena');
    assert.ok(harnessWasm.length > 0);
  });

  // Find all .wit files
  const testsDir = join(__dirname, '../tests');
  const witFiles = findWitFiles(testsDir);

  console.log(`  Found ${witFiles.length} .wit files to test`);

  for (const witFile of witFiles) {
    const relativePath = witFile.substring(testsDir.length + 1);

    test(`lexes ${relativePath}`, async () => {
      const source = readFileSync(witFile, 'utf-8');
      const inputBytes = new TextEncoder().encode(source);

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
        harnessWasm as BufferSource,
        imports as WebAssembly.Imports,
      );
      const instance = (result as unknown as {instance: WebAssembly.Instance})
        .instance;

      // Just call countTokens - if it doesn't throw, lexing succeeded
      const countTokens = instance.exports.countTokens as () => number;
      const count = countTokens();
      assert.ok(
        count >= 0,
        `Should tokenize without error (got ${count} tokens)`,
      );
    });
  }
});
