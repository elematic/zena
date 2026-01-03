#!/usr/bin/env node
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import {join, resolve, dirname, relative, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {suite, test} from 'node:test';

// Import compiler
import {Parser, TypeChecker, CodeGenerator, Compiler} from '../lib/index.js';

import {createStringReader} from '@zena-lang/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
// We are in packages/compiler/test/portable-runner.js
// Root is ../../../
const rootDir = resolve(__dirname, '../../..');
const testsDir = join(rootDir, 'tests');

// Colors (kept for snapshot generation messages)
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

interface TestDirectives {
  mode?: 'parse' | 'check' | 'run';
  target?: 'module' | 'statement' | 'expression';
  result?: string;
  stdout?: string;
  throws?: string; // Expected exception type (e.g., 'wasm' for WebAssembly.Exception)
  [key: string]: string | undefined;
}

interface ExpectedError {
  line: number;
  regex: RegExp;
}

interface TestSuiteMetadata {
  name?: string;
  description?: string;
  expected?: {
    pass?: number;
    fail?: number;
    skip?: number;
  };
}

interface SuiteResults {
  pass: number;
  fail: number;
  skip: number;
}

function loadSuiteMetadata(dir: string): TestSuiteMetadata | null {
  const metadataPath = join(dir, 'test-suite.json');
  if (!existsSync(metadataPath)) return null;
  try {
    return JSON.parse(readFileSync(metadataPath, 'utf-8'));
  } catch (e) {
    console.warn(`Failed to parse test-suite.json in ${dir}:`, e);
    return null;
  }
}

function validateSuiteResults(
  suitePath: string,
  metadata: TestSuiteMetadata,
  results: SuiteResults,
): void {
  const expected = metadata.expected;
  if (!expected) return;

  const errors: string[] = [];

  if (expected.pass !== undefined && results.pass !== expected.pass) {
    errors.push(`pass: expected ${expected.pass}, got ${results.pass}`);
  }
  if (expected.fail !== undefined && results.fail !== expected.fail) {
    errors.push(`fail: expected ${expected.fail}, got ${results.fail}`);
  }
  if (expected.skip !== undefined && results.skip !== expected.skip) {
    errors.push(`skip: expected ${expected.skip}, got ${results.skip}`);
  }

  if (errors.length > 0) {
    throw new Error(
      `Suite "${metadata.name || suitePath}" test count mismatch:\n  ${errors.join('\n  ')}`,
    );
  }
}

function getAllTests(dir: string): string[] {
  let results: string[] = [];
  if (!existsSync(dir)) return [];
  const list = readdirSync(dir);
  for (const file of list) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllTests(filePath));
    } else if (file.endsWith('.zena')) {
      results.push(filePath);
    }
  }
  return results;
}

function parseDirectives(content: string): {
  directives: TestDirectives;
  errors: ExpectedError[];
} {
  const directives: TestDirectives = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*\/\/ @(\w+): (.*)$/);
    if (match) {
      directives[match[1]] = match[2].trim();
    }
  }

  // Parse inline errors: // @error: regex
  const errors: ExpectedError[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const errorMatch = line.match(/\/\/ @error: (.*)$/);
    if (errorMatch) {
      errors.push({
        line: i + 1, // 1-based
        regex: new RegExp(errorMatch[1]),
      });
    }
  }

  return {directives, errors};
}

function stripLocation(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(stripLocation);
  } else if (obj && typeof obj === 'object') {
    const newObj: any = {};
    for (const key in obj) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      newObj[key] = stripLocation(obj[key]);
    }
    return newObj;
  }
  return obj;
}

async function runTestFile(filePath: string): Promise<void> {
  const content = readFileSync(filePath, 'utf-8');
  const {directives, errors} = parseDirectives(content);
  const relPath = relative(testsDir, filePath);

  // Infer mode if not specified
  let mode = directives.mode;
  if (!mode) {
    if (relPath.includes('syntax')) mode = 'parse';
    else if (relPath.includes('semantics')) mode = 'check';
    else if (relPath.includes('execution')) mode = 'run';
    else if (relPath.includes('stdlib')) mode = 'run'; // Stdlib tests are execution tests
    else mode = 'parse'; // Default
  }

  if (mode === 'parse') {
    await runParseTest(filePath, content, directives, relPath);
  } else if (mode === 'check') {
    await runCheckTest(filePath, content, directives, errors, relPath);
  } else if (mode === 'run') {
    await runExecutionTest(filePath, content, directives, relPath);
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}

async function runParseTest(
  filePath: string,
  content: string,
  directives: TestDirectives,
  relPath: string,
) {
  const parser = new Parser(content);
  const ast = parser.parse();

  let actual: any = ast;
  if (directives.target === 'statement') {
    actual = ast.body[0];
  } else if (directives.target === 'expression') {
    // Assuming expression statement
    if (ast.body[0].type === 'ExpressionStatement') {
      actual = (ast.body[0] as any).expression;
    }
  }

  const cleanAst = stripLocation(actual);
  const astJsonPath = filePath.replace('.zena', '.ast.json');

  if (!existsSync(astJsonPath)) {
    // Generate expectation
    writeFileSync(astJsonPath, JSON.stringify(cleanAst, null, 2));
    console.log(`${gray('Generated AST snapshot for')} ${relPath}`);
  } else {
    const expected = JSON.parse(readFileSync(astJsonPath, 'utf-8'));
    const actualJson = JSON.stringify(cleanAst, null, 2);
    const expectedJson = JSON.stringify(expected, null, 2);

    if (actualJson !== expectedJson) {
      throw new Error(
        `AST mismatch.\nExpected:\n${expectedJson}\nActual:\n${actualJson}`,
      );
    }
  }
}

async function runCheckTest(
  filePath: string,
  content: string,
  directives: TestDirectives,
  expectedErrors: ExpectedError[],
  relPath: string,
) {
  const parser = new Parser(content);
  const ast = parser.parse();
  const checker = new TypeChecker(ast);
  const diagnostics = checker.check();

  // Match expected errors
  for (const expected of expectedErrors) {
    const found = diagnostics.find((d) => {
      return expected.regex.test(d.message);
    });

    if (!found) {
      throw new Error(
        `Expected error matching ${expected.regex} on line ${expected.line}, but found none.`,
      );
    }
  }

  if (expectedErrors.length === 0 && diagnostics.length > 0) {
    throw new Error(
      `Unexpected errors: ${diagnostics.map((d) => d.message).join(', ')}`,
    );
  }
}

async function runExecutionTest(
  filePath: string,
  content: string,
  directives: TestDirectives,
  relPath: string,
) {
  // Mock host
  const host = {
    load: (path: string) => {
      if (path === '/main.zena') return content;
      if (path.startsWith('zena:')) {
        // Load stdlib
        const name = path.substring(5);
        try {
          return readFileSync(
            join(rootDir, 'packages/stdlib/zena', `${name}.zena`),
            'utf-8',
          );
        } catch (e) {
          throw new Error(`Stdlib module not found: ${name}`);
        }
      }
      throw new Error(`File not found: ${path}`);
    },
    resolve: (specifier: string, referrer: string) => specifier,
  };

  const compiler = new Compiler(host);
  const program = compiler.bundle('/main.zena');

  const checker = new TypeChecker(program, compiler, {
    path: '/main.zena',
    exports: new Map(),
    isStdlib: true, // Allow internal features
  } as any);
  // Load prelude
  checker.preludeModules = compiler.preludeModules;

  const diagnostics = checker.check();
  if (diagnostics.length > 0) {
    throw new Error(
      `Compilation failed: ${diagnostics.map((d) => d.message).join(', ')}`,
    );
  }

  const codegen = new CodeGenerator(program);
  const bytes = codegen.generate();

  let stdout = '';

  const logString = (ptr: number, len: number) => {
    if (!instanceExports) return;
    if (!stringReader) {
      try {
        stringReader = createStringReader(instanceExports);
      } catch (e) {
        return;
      }
    }
    if (stringReader) {
      stdout += stringReader(ptr, len) + '\n';
    }
  };

  const imports: any = {
    console: {
      log_i32: (v: number) => {
        stdout += v + '\n';
      },
      log_f32: (v: number) => {
        stdout += v + '\n';
      },
      log_string: logString,
      error_string: logString,
      warn_string: logString,
      info_string: logString,
      debug_string: logString,
    },
  };

  let instanceExports: any;
  let stringReader: ((ptr: unknown, len: number) => string) | null = null;

  const result = await WebAssembly.instantiate(bytes, imports);
  instanceExports = (result as any).instance.exports;
  // Initialize reader immediately if exports are available
  try {
    stringReader = createStringReader(instanceExports);
  } catch (e) {
    // Ignore if exports are missing (e.g. no string usage)
  }

  const readString = (ptr: any): string | null => {
    if (!instanceExports || !instanceExports.$stringGetLength) return null;
    if (!stringReader) return null;

    try {
      const len = instanceExports.$stringGetLength(ptr);
      return stringReader(ptr, len);
    } catch (e) {
      return null;
    }
  };

  // Handle @throws directive - expect an exception
  if (directives.throws) {
    if (!instanceExports.main) {
      throw new Error('Test expects throws but no main function found');
    }
    try {
      (instanceExports.main as Function)();
      throw new Error(
        `Expected ${directives.throws} exception but none was thrown`,
      );
    } catch (e) {
      if (directives.throws === 'wasm') {
        if (!(e instanceof (WebAssembly as any).Exception)) {
          throw new Error(
            `Expected WebAssembly.Exception but got ${(e as Error).constructor.name}: ${(e as Error).message}`,
          );
        }
        // Success - expected exception was thrown
        return;
      }
      // Unknown throws type - re-throw
      throw e;
    }
  }

  if (instanceExports.main) {
    const ret = (instanceExports.main as Function)();
    if (directives.result) {
      let actual: string;

      if (typeof ret === 'object' || typeof ret === 'function') {
        const str = readString(ret);
        if (str !== null) {
          actual = str;
        } else {
          try {
            actual = String(ret);
          } catch (e) {
            actual = '[object]';
          }
        }
      } else {
        actual = String(ret);
        if (directives.result === 'true' && ret === 1) actual = 'true';
        if (directives.result === 'false' && ret === 0) actual = 'false';
      }

      if (actual !== directives.result) {
        throw new Error(
          `Expected result ${directives.result}, got ${actual} (raw: ${ret})`,
        );
      }
    }
  }

  if (directives.stdout) {
    const expectedStdout = directives.stdout.replace(/\\n/g, '\n');
    if (stdout.trim() !== expectedStdout.trim()) {
      throw new Error(`Expected stdout:\n${expectedStdout}\nGot:\n${stdout}`);
    }
  }
}

// Group tests by directory for suites
interface TestGroup {
  name: string;
  tests: string[];
  dirPath: string;
  metadata: TestSuiteMetadata | null;
}

function groupTestsByDirectory(testFiles: string[]): TestGroup[] {
  const groups = new Map<string, {tests: string[]; dirPath: string}>();

  for (const filePath of testFiles) {
    const relPath = relative(testsDir, filePath);
    const dir = dirname(relPath);
    const suiteName = dir.replace(/\//g, ' / ') || 'root';
    const dirPath = join(testsDir, dir);

    if (!groups.has(suiteName)) {
      groups.set(suiteName, {tests: [], dirPath});
    }
    groups.get(suiteName)!.tests.push(filePath);
  }

  return Array.from(groups.entries()).map(([name, {tests, dirPath}]) => ({
    name,
    tests,
    dirPath,
    metadata: loadSuiteMetadata(dirPath),
  }));
}

// Register all tests with Node's test runner
const allTests = getAllTests(testsDir);
const testGroups = groupTestsByDirectory(allTests);

for (const group of testGroups) {
  const suiteName = group.metadata?.name
    ? `Portable: ${group.name} (${group.metadata.name})`
    : `Portable: ${group.name}`;

  suite(suiteName, async () => {
    const results: SuiteResults = {pass: 0, fail: 0, skip: 0};

    for (const filePath of group.tests) {
      const testName = basename(filePath, '.zena');
      test(testName, async () => {
        try {
          await runTestFile(filePath);
          results.pass++;
        } catch (e) {
          results.fail++;
          throw e;
        }
      });
    }

    // Validate expected counts after all tests in suite complete
    if (group.metadata?.expected) {
      test('validate suite expectations', () => {
        validateSuiteResults(group.dirPath, group.metadata!, results);
      });
    }
  });
}
