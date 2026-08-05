/**
 * Dev tool: run the Zena WIT parser over real-world WIT, outside the
 * ported wasm-tools UI corpus.
 *
 * The UI corpus is synthetic and does not exercise several combinations that
 * every shipping WASI package uses, so passing it is not evidence that we can
 * parse `wasi:http`. This script closes that gap.
 *
 *   node dev/parse-real-wit.mjs <wit-dir> [...]   parse whole WIT packages
 *   node dev/parse-real-wit.mjs --files <wit-dir> parse each file separately
 *   node dev/parse-real-wit.mjs --probe           run minimal construct repros
 *
 * Fetch a corpus to point it at, e.g.:
 *   curl -L https://github.com/WebAssembly/wasi-http/archive/refs/heads/main.tar.gz | tar xz
 *   node dev/parse-real-wit.mjs wasi-http-main/wit wasi-http-main/wit-0.3.0-draft
 */
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, posix, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as fs from 'node:fs';
import {Compiler, CodeGenerator} from '@zena-lang/compiler';
import {instantiate} from '@zena-lang/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stdlibPath = join(__dirname, '../../stdlib/zena');
const witParserPath = join(__dirname, '../zena');

// Mirrors createHost() in src/scripts/run-tests.ts.
const createHost = () => ({
  load: (p) => {
    if (p.startsWith('/wit-parser/')) {
      return fs.readFileSync(
        join(witParserPath, p.substring('/wit-parser/'.length)),
        'utf-8',
      );
    }
    if (p.startsWith('zena:')) {
      const name = p.substring(5);
      const rel = name.endsWith('.zena') ? name : `${name}.zena`;
      return fs.readFileSync(join(stdlibPath, rel), 'utf-8');
    }
    throw new Error(`File not found: ${p}`);
  },
  resolve: (specifier, referrer) => {
    if (specifier.startsWith('./') && referrer.startsWith('/wit-parser/')) {
      return '/wit-parser/' + specifier.substring(2);
    }
    if (specifier === 'zena:console') return 'zena:console/host.zena';
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      referrer.startsWith('zena:')
    ) {
      return (
        'zena:' +
        posix.normalize(posix.join(posix.dirname(referrer.slice(5)), specifier))
      );
    }
    return specifier;
  },
});

let cachedWasm = null;
const compileParserHarness = () => {
  if (cachedWasm) return cachedWasm;
  const compiler = new Compiler(createHost());
  const entryPoint = '/wit-parser/parser-test-harness.zena';
  const modules = compiler.compile(entryPoint);
  const errors = modules.flatMap((m) => m.diagnostics ?? []);
  if (errors.length > 0) {
    throw new Error(
      `Compilation failed: ${errors.map((e) => e.message).join(', ')}`,
    );
  }
  const generator = new CodeGenerator(
    modules,
    entryPoint,
    compiler.semanticContext,
    compiler.checkerContext,
    {debug: true},
  );
  cachedWasm = generator.generate();
  return cachedWasm;
};

/** Run the parser. `resolve: true` also runs name resolution + JSON output. */
const runParser = async (source, resolve = false) => {
  const wasm = compileParserHarness();
  const inputBytes = new TextEncoder().encode(source);
  const result = await instantiate(wasm, {
    input: {
      getLength: () => inputBytes.length,
      getByte: (i) => inputBytes[i] ?? 0,
    },
  });
  const instance = 'instance' in result ? result.instance : result;
  const e = instance.exports;
  if (resolve) e.parseJson();
  else e.parse();
  const len = e.getOutputLength();
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = e.getOutputByte(i);
  return new TextDecoder().decode(bytes);
};

const failed = (out) => out.startsWith('ParseError:') || out.startsWith('THREW');

const tryParse = async (source, resolve) => {
  try {
    return await runParser(source, resolve);
  } catch (err) {
    return `THREW: ${err.message}`;
  }
};

/** Collect .wit files, deps first (packages must be registered before use). */
const findWitFiles = async (dir) => {
  const deps = [];
  const main = [];
  const walk = async (cur, isDep) => {
    for (const entry of await readdir(cur, {withFileTypes: true})) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) await walk(full, isDep || entry.name === 'deps');
      else if (entry.name.endsWith('.wit')) (isDep ? deps : main).push(full);
    }
  };
  await walk(dir, false);
  return {deps: deps.sort(), main: main.sort()};
};

const parseDir = async (dir) => {
  const {deps, main} = await findWitFiles(dir);
  const all = [...main, ...deps];
  const contents = [];
  for (const f of all) contents.push(await readFile(f, 'utf-8'));
  const input = contents.join('\n');
  console.log(`\n=== ${dir} === (${all.length} files, ${input.length} bytes)`);
  const out = await tryParse(input, true);
  if (failed(out)) {
    console.log(`  ❌ ${out.split('\n')[0]}`);
    return false;
  }
  try {
    const json = JSON.parse(out);
    const pkgs = (json.packages ?? []).map((p) => p.name);
    console.log(
      `  ✅ ${pkgs.length} packages, ${(json.interfaces ?? []).length} interfaces, ` +
        `${(json.worlds ?? []).length} worlds`,
    );
    return true;
  } catch {
    console.log(`  ⚠️  output was not valid JSON: ${out.slice(0, 200)}`);
    return false;
  }
};

/** Parse each file alone. Cross-file `use` will fail; syntax errors still show. */
const parseFiles = async (dir) => {
  const {deps, main} = await findWitFiles(dir);
  for (const f of [...main, ...deps]) {
    const out = await tryParse(await readFile(f, 'utf-8'), false);
    console.log(
      `${failed(out) ? '❌' : '✅'} ${relative(dir, f)}` +
        `${failed(out) ? ` — ${out.split('\n')[0]}` : ''}`,
    );
  }
};

const NL = String.fromCharCode(10);
const P = `package test:probe;${NL}`;

/**
 * Minimal repros for the three gaps that block real WASI WIT but are not
 * covered by the ported wasm-tools UI corpus. See
 * docs/design/component-model.md, Part 9.
 */
const PROBES = {
  // Gap 1: prerelease / build metadata in a use-path version.
  'use @1.0.0 (baseline, resolves later)':
    P + 'interface i { use foo:bar/baz@1.0.0.{a}; }',
  'use @1.0.0-alpha': P + 'interface i { use foo:bar/baz@1.0.0-alpha.{a}; }',
  'use @1.0.0-rc-1': P + 'interface i { use foo:bar/baz@1.0.0-rc-1.{a}; }',
  'use @1.0.0-rc.1': P + 'interface i { use foo:bar/baz@1.0.0-rc.1.{a}; }',
  'use @0.3.0-rc-2025-09-16 (all of WASI p3)':
    P + 'interface i { use foo:bar/baz@0.3.0-rc-2025-09-16.{a}; }',
  'use @1.0.0+build': P + 'interface i { use foo:bar/baz@1.0.0+build.{a}; }',
  'package decl @0.3.0-rc-2025-09-16 (works)':
    'package wasi:http@0.3.0-rc-2025-09-16;' + NL + 'interface i { }',
  '@since(version = 0.3.0-rc-2025-09-16) (works)':
    P + '@since(version = 0.3.0-rc-2025-09-16)' + NL + 'interface i { }',

  // Gap 2: versioned interface path in world import/export (plain semver).
  'world import versioned path':
    P + 'world w { import wasi:clocks/monotonic-clock@0.2.8; }',
  'world export versioned path':
    P + 'world w { export wasi:http/incoming-handler@0.2.8; }',
  'world include versioned path (works)':
    P + 'world w { include wasi:http/imports@0.2.8; }',

  // Gap 3: doc comment inside a function parameter list.
  'doc comment in param list':
    P +
    ['interface i {', '  f: func(', '    /// how many', '    len: u64', '  ) -> u32;', '}'].join(NL),
  'line comment in param list (works)':
    P +
    ['interface i {', '  f: func(', '    // how many', '    len: u64', '  ) -> u32;', '}'].join(NL),
  'doc comment in record (works)':
    P +
    ['interface i {', '  record r {', '    /// a field', '    a: u64,', '  }', '}'].join(NL),
};

/**
 * These snippets reference packages that do not exist, so a "not found"
 * resolution error means the syntax parsed fine — which is the thing under
 * test. Only genuine syntax errors count as failures here.
 */
const isResolutionError = (out) => /not found/.test(out);

const probe = async () => {
  for (const [name, src] of Object.entries(PROBES)) {
    const out = await tryParse(src, false);
    const parsedOk = !failed(out) || isResolutionError(out);
    const note = !failed(out)
      ? ''
      : isResolutionError(out)
        ? ' (parsed; resolution error expected)'
        : ` — ${out.split(NL)[0]}`;
    console.log(`${parsedOk ? '✅' : '❌'} ${name}${note}`);
  }
};

const args = process.argv.slice(2);
if (args[0] === '--probe') {
  await probe();
} else if (args[0] === '--files') {
  for (const dir of args.slice(1)) await parseFiles(dir);
} else if (args.length === 0) {
  console.error('usage: parse-real-wit.mjs [--probe|--files] <wit-dir>...');
  process.exit(1);
} else {
  let ok = true;
  for (const dir of args) ok = (await parseDir(dir)) && ok;
  process.exit(ok ? 0 : 1);
}
