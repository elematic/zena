/**
 * Dev tool: run the Zena WIT parser over real-world WIT, outside the
 * ported wasm-tools UI corpus.
 *
 * The UI corpus is synthetic and does not exercise several combinations that
 * every shipping WASI package uses, so passing it is not evidence that we can
 * parse `wasi:http`. This script closes that gap.
 *
 *   node dev/parse-real-wit.js --check           assert the pinned corpus (CI check)
 *   node dev/parse-real-wit.js <wit-dir> [...]   parse whole WIT packages
 *   node dev/parse-real-wit.js --files <wit-dir> parse each file separately
 *   node dev/parse-real-wit.js --probe           run minimal construct repros
 *
 * `--check` uses the pinned corpus (wit-corpus.json), which arrives either from
 * `nix develop` (ZENA_WASI_WIT) or from `node dev/fetch-wit-corpus.js`. The
 * other modes take explicit directories, so they work on any WIT you point them
 * at, pinned or not.
 */
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, posix, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  findCorpus,
  MISSING_CORPUS_MESSAGE,
  readManifest,
  verifyCorpus,
} from './wit-corpus.js';
import * as fs from 'node:fs';
import {instantiate} from '@zena-lang/runtime';
import {compileZenaFile} from '../scripts/compile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const witParserPath = join(__dirname, '../zena');

let cachedWasm = null;
const compileParserHarness = () => {
  if (cachedWasm) return cachedWasm;
  cachedWasm = compileZenaFile(join(witParserPath, 'parser-test-harness.zena'));
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

const failed = (out) =>
  out.startsWith('ParseError:') || out.startsWith('THREW');

const tryParse = async (source, resolve) => {
  try {
    return await runParser(source, resolve);
  } catch (err) {
    return `THREW: ${err.message}`;
  }
};

const PKG_HEADER = /^\s*package\s+[\w-]+:[\w-]+(@[\w.+-]+)?\s*;/m;

/**
 * Order one directory's files, putting the one that carries the `package …;`
 * header first.
 *
 * The parser takes a single string, so a package's header has to appear before
 * that package's items. wasm-tools has no such constraint — it parses each file
 * on its own and merges them by package name — and WASI depends on that:
 * `wasi:sockets` declares its header only in `world.wit`, which sorts last, so
 * plain alphabetical order puts seven interfaces ahead of their own package.
 */
const headerFirst = async (paths) => {
  const files = [];
  for (const p of [...paths].sort())
    files.push([p, await readFile(p, 'utf-8')]);
  return [
    ...files.filter(([, s]) => PKG_HEADER.test(s)),
    ...files.filter(([, s]) => !PKG_HEADER.test(s)),
  ];
};

/** `package ns:name@version;` — the package a directory declares. */
const PKG_DECL = /^\s*package\s+([\w-]+:[\w-]+)(?:@[\w.+-]+)?\s*;/m;
/** `ns:name/iface` inside a `use`/`import` path — a foreign package reference. */
const PKG_REF = /\b([a-z0-9][\w-]*:[\w-]+)(?:@[\w.+-]+)?\//g;
/** Only these lines carry real references; doc comments mention packages too. */
const REF_LINE = /^\s*(?:use|import|export|include)\b/;

/** Foreign packages a source references, ignoring the ones named in prose. */
const packageRefs = (text, own) => {
  const refs = new Set();
  for (const line of text.split('\n')) {
    if (!REF_LINE.test(line)) continue;
    for (const m of line.matchAll(PKG_REF)) if (m[1] !== own) refs.add(m[1]);
  }
  return refs;
};

/**
 * Collect .wit files as `[path, source]` pairs in an order the parser can
 * consume: a package must be declared before anything references it.
 *
 * Directory order is topological, not alphabetical — `deps/cli` sorts first but
 * depends on `io`, `clocks`, `filesystem`, `sockets` and `random`. wasm-tools
 * resolves packages as a graph and needs no such ordering.
 */
const findWitFiles = async (dir) => {
  const buckets = new Map(); // directory -> {isDep, paths}
  const walk = async (cur, isDep) => {
    for (const entry of await readdir(cur, {withFileTypes: true})) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) await walk(full, isDep || entry.name === 'deps');
      else if (entry.name.endsWith('.wit')) {
        if (!buckets.has(cur)) buckets.set(cur, {isDep, paths: []});
        buckets.get(cur).paths.push(full);
      }
    }
  };
  await walk(dir, false);

  const units = [];
  for (const d of [...buckets.keys()].sort()) {
    const {isDep, paths} = buckets.get(d);
    const files = await headerFirst(paths);
    const text = files.map(([, src]) => src).join('\n');
    const own = text.match(PKG_DECL)?.[1] ?? null;
    units.push({isDep, files, own, refs: packageRefs(text, own)});
  }

  const providers = new Map();
  for (const u of units) if (u.own != null) providers.set(u.own, u);

  // Post-order DFS: a unit is emitted after everything it references. A cycle
  // among packages is left in discovery order rather than being an error —
  // this is a diagnostic tool, and the parser should be the one to complain.
  const ordered = [];
  const done = new Set();
  const visit = (u, onStack) => {
    if (done.has(u) || onStack.has(u)) return;
    onStack.add(u);
    for (const ref of u.refs) {
      const provider = providers.get(ref);
      if (provider != null && provider !== u) visit(provider, onStack);
    }
    onStack.delete(u);
    done.add(u);
    ordered.push(u);
  };
  for (const u of units) if (u.isDep) visit(u, new Set());
  for (const u of units) visit(u, new Set());

  return ordered.flatMap((u) => u.files);
};

const parseDir = async (dir) => {
  const all = await findWitFiles(dir);
  const input = all.map(([, src]) => src).join('\n');
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
  for (const [f, src] of await findWitFiles(dir)) {
    const out = await tryParse(src, false);
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
    [
      'interface i {',
      '  f: func(',
      '    /// how many',
      '    len: u64',
      '  ) -> u32;',
      '}',
    ].join(NL),
  'line comment in param list (works)':
    P +
    [
      'interface i {',
      '  f: func(',
      '    // how many',
      '    len: u64',
      '  ) -> u32;',
      '}',
    ].join(NL),
  'doc comment in record (works)':
    P +
    [
      'interface i {',
      '  record r {',
      '    /// a field',
      '    a: u64,',
      '  }',
      '}',
    ].join(NL),
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

/**
 * What each pinned tree is expected to resolve to, as `<source>/<subdir>`.
 * Exact counts, so a regression cannot hide; the pins are fixed commits, so
 * they do not drift.
 */
const EXPECTED = [
  {
    label: 'wasi 0.2 (wasi:http@0.2.8)',
    dir: 'wasi-http/wit',
    packages: 7,
    interfaces: 31,
    worlds: 9,
  },
  {
    label: 'wasi 0.3.0-rc-2025-09-16 draft',
    dir: 'wasi-http/wit-0.3.0-draft',
    packages: 6,
    interfaces: 25,
    worlds: 8,
  },
  {
    // Released 0.3, and a different shape: one wit/ per proposal, no vendored
    // deps, so this leans on the topological package ordering.
    label: 'wasi 0.3.0 (released)',
    dir: 'wasi/proposals',
    packages: 6,
    interfaces: 25,
    worlds: 8,
  },
];

/**
 * The gating check: assert every pinned tree still resolves.
 *
 * Absence is a failure, never a skip — a check that quietly skips reports the
 * same green tick as one that ran, which is how "we test against real WASI"
 * turns into a claim nobody has verified in months.
 */
const check = async () => {
  const found = await findCorpus();
  if (found == null) {
    console.error(MISSING_CORPUS_MESSAGE);
    process.exit(1);
  }
  const manifest = await readManifest();
  const problems = await verifyCorpus(found.dir, manifest);
  if (problems.length > 0) {
    console.error(`✗ corpus at ${found.source} does not match wit-corpus.json`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('  Re-fetch with: node dev/fetch-wit-corpus.js');
    process.exit(1);
  }
  const pins = Object.entries(manifest.sources)
    .map(([n, src]) => `${n}@${src.ref}`)
    .join(', ');
  console.log(`corpus: ${found.source} (${pins})`);

  const failures = [];
  for (const want of EXPECTED) {
    const out = await tryParse(
      (await findWitFiles(join(found.dir, want.dir)))
        .map(([, src]) => src)
        .join(NL),
      true,
    );
    if (failed(out)) {
      failures.push(`${want.label} no longer resolves: ${out.split(NL)[0]}`);
      continue;
    }
    const json = JSON.parse(out);
    const got = {
      packages: (json.packages ?? []).length,
      interfaces: (json.interfaces ?? []).length,
      worlds: (json.worlds ?? []).length,
    };
    const expected = {
      packages: want.packages,
      interfaces: want.interfaces,
      worlds: want.worlds,
    };
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failures.push(
        `${want.label} resolved to ${JSON.stringify(got)}, ` +
          `expected ${JSON.stringify(expected)}`,
      );
    } else {
      console.log(
        `✔ ${want.label}: ${got.packages} packages, ` +
          `${got.interfaces} interfaces, ${got.worlds} worlds`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`✗ ${f}`);
    process.exit(1);
  }
};

const args = process.argv.slice(2);
if (args[0] === '--check') {
  await check();
} else if (args[0] === '--probe') {
  await probe();
} else if (args[0] === '--files') {
  for (const dir of args.slice(1)) await parseFiles(dir);
} else if (args.length === 0) {
  console.error(
    'usage: parse-real-wit.js [--check|--probe|--files] <wit-dir>...',
  );
  process.exit(1);
} else {
  let ok = true;
  for (const dir of args) ok = (await parseDir(dir)) && ok;
  process.exit(ok ? 0 : 1);
}
