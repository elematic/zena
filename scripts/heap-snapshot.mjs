// Heap snapshots of a compile, under V8.
//
// Runs the `js`-target compiler build (`lsp.wasm`, the language
// service's module, which exports `compileToWasm`) under Node, compiles
// one entry, and writes a V8 heap snapshot — either when the compile is
// done, which after V8's full collection is the retained set, or at the
// N-th read of the clock, which the compiler's phase timer takes at
// every phase boundary, so a snapshot can land inside a phase.
//
// Node's own snapshot machinery does the work; nothing in the compiler
// or the runtime changes. Sizes are V8's, not wasmtime's (a different
// header and no 16-byte rounding), so read the counts as exact and the
// bytes as proportions.
//
//   node scripts/heap-snapshot.mjs run <entry.zena> [--at-clock N] [-o out.heapsnapshot]
//   node scripts/heap-snapshot.mjs clocks <entry.zena>        # list clock reads with timestamps
//   node scripts/heap-snapshot.mjs analyze <file.heapsnapshot> [--top N]
//   node scripts/heap-snapshot.mjs retainers <file.heapsnapshot> <class-regex> [--top N]
//
// Paths are relative to the repository root. `npm run build -w
// @zena-lang/language-service` builds the module. The compiler's own
// recursion overflows Node's default stack: run with
// `--stack-size=200000` after `ulimit -s unlimited`, and give a large
// compile `--max-old-space-size=20000`.

import {readFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import v8 from 'node:v8';
import {
  createStringReader,
  createStringWriter,
  createConsoleImports,
} from '@zena-lang/runtime';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const lspWasm = join(root, 'packages', 'language-service', 'lsp.wasm');
const stdlibDir = join(root, 'packages', 'stdlib', 'zena');

const args = process.argv.slice(2);
const mode = args.shift();
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const readProjectFile = (path) => {
  let p = path;
  if (p.startsWith('/stdlib/')) p = join(stdlibDir, p.slice('/stdlib/'.length));
  else if (p.startsWith('/')) p = join(root, p.slice(1));
  else p = join(root, p);
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
};

const instantiate = async (onClock) => {
  let exports;
  let readString;
  let writeString;
  const readFileImport = (pathRef, pathLen) => {
    const raw = readString(pathRef, pathLen);
    const contents = readProjectFile(raw);
    return contents == null ? null : writeString(contents);
  };
  let clockReads = 0;
  const imports = {
    console: createConsoleImports(() => exports),
    compiler: {read_file: readFileImport},
    time: {
      now_ms: () => {
        clockReads += 1;
        onClock?.(clockReads, performance.now());
        return performance.now();
      },
      sleep_ms: () => {},
    },
    env: {
      getStackTrace: () => null,
      captureStackTrace: () => null,
      formatStackTrace: () => null,
    },
  };
  const bytes = readFileSync(lspWasm);
  const {instance} = await WebAssembly.instantiate(bytes, imports);
  exports = instance.exports;
  readString = createStringReader(exports);
  writeString = createStringWriter(exports);
  exports.init(writeString('/stdlib'));
  return {exports, writeString, readString};
};

const compile = async (entry, onClock) => {
  const {exports, writeString, readString} = await instantiate(onClock);
  const source = readProjectFile(entry);
  if (source == null) throw new Error(`cannot read ${entry}`);
  const t0 = performance.now();
  const out = exports.compileToWasm(writeString(entry), writeString(source));
  const ms = Math.round(performance.now() - t0);
  const bytes = out == null ? 0 : exports.getByteArrayLength(out);
  console.error(`compiled ${entry}: ${bytes} bytes in ${ms} ms`);
  if (out == null) {
    const diags = exports.check(writeString(entry), writeString(source));
    const n = exports.getDiagnosticCount(diags);
    const str = (ref) =>
      ref == null ? '' : readString(ref, exports.$stringGetLength(ref));
    // Errors first: a failed compile's cause is usually behind a screen
    // of unused-import warnings.
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        severity: exports.getDiagnosticSeverity(diags, i),
        file: str(exports.getDiagnosticFile(diags, i)),
        line: exports.getDiagnosticLine(diags, i),
        msg: str(exports.getDiagnosticMessage(diags, i)),
      });
    }
    rows.sort((a, b) => a.severity - b.severity);
    for (const r of rows.slice(0, 12)) {
      console.error(`  [${r.severity}] ${r.file}:${r.line}: ${r.msg}`);
    }
    console.error(`  (${n} diagnostics)`);
  }
};

// A snapshot of a compile is hundreds of MiB, past what `JSON.parse`
// takes as one string, so the file is read as bytes: the `snapshot`
// header and the `strings` table (the last key) are parsed as JSON on
// their own, and the `nodes` array — integers only — is scanned.
const readSnapshot = (file) => {
  const buf = readFileSync(file);
  const find = (needle, from = 0) => buf.indexOf(needle, from, 'latin1');
  const nodesAt = find('"nodes":[');
  const edgesAt = find('"edges":[', nodesAt);
  const header = JSON.parse(
    buf
      .toString('utf8', 0, nodesAt - 1)
      .trim()
      .replace(/,$/, '') + '}',
  );
  const stringsAt = find('"strings":[');
  const stringsEnd = buf.lastIndexOf(']', buf.length - 1, 'latin1');
  const strings = JSON.parse(
    buf.toString('utf8', stringsAt + '"strings":'.length, stringsEnd + 1),
  );
  const nodes = [];
  let n = -1;
  for (let i = nodesAt + '"nodes":['.length; i < edgesAt; i++) {
    const c = buf[i];
    if (c >= 48 && c <= 57) {
      n = (n < 0 ? 0 : n * 10) + (c - 48);
    } else if (n >= 0) {
      nodes.push(n);
      n = -1;
    }
  }
  return {snapshot: header.snapshot, nodes, strings};
};

// Who holds the objects of one class: for every node whose name
// matches `pattern`, the names of the nodes with an edge to it, summed.
// Edges are stored per node in node order (`edge_count` each), the
// target as a byte offset into `nodes`.
const retainers = (file, pattern, top) => {
  const buf = readFileSync(file);
  const find = (needle, from = 0) => buf.indexOf(needle, from, 'latin1');
  const nodesAt = find('"nodes":[');
  const edgesAt = find('"edges":[');
  const edgesEnd = find(']', edgesAt);
  const header = JSON.parse(
    buf
      .toString('utf8', 0, nodesAt - 1)
      .trim()
      .replace(/,$/, '') + '}',
  );
  const stringsAt = find('"strings":[');
  const stringsEnd = buf.lastIndexOf(']', buf.length - 1, 'latin1');
  const strings = JSON.parse(
    buf.toString('utf8', stringsAt + '"strings":'.length, stringsEnd + 1),
  );
  const scan = (from, to) => {
    const out = [];
    let n = -1;
    for (let i = from; i < to; i++) {
      const c = buf[i];
      if (c >= 48 && c <= 57) n = (n < 0 ? 0 : n * 10) + (c - 48);
      else if (n >= 0) {
        out.push(n);
        n = -1;
      }
    }
    return out;
  };
  const nodes = scan(nodesAt + '"nodes":['.length, edgesAt);
  const edges = scan(edgesAt + '"edges":['.length, edgesEnd);
  const nf = header.snapshot.meta.node_fields;
  const ef = header.snapshot.meta.edge_fields;
  const ns = nf.length;
  const es = ef.length;
  const iName = nf.indexOf('name');
  const iEdges = nf.indexOf('edge_count');
  const iTo = ef.indexOf('to_node');
  const re = new RegExp(pattern);
  const wanted = new Uint8Array(nodes.length / ns);
  let matched = 0;
  for (let i = 0; i < nodes.length; i += ns) {
    if (re.test(strings[nodes[i + iName]])) {
      wanted[i / ns] = 1;
      matched += 1;
    }
  }
  // Distinct targets per holder class, and edges: a path string shared
  // by every location in a module is one target under many edges.
  const edgesByHolder = new Map();
  const targetsByHolder = new Map();
  let e = 0;
  for (let i = 0; i < nodes.length; i += ns) {
    const count = nodes[i + iEdges];
    const holder = strings[nodes[i + iName]];
    for (let k = 0; k < count; k++, e += es) {
      const to = edges[e + iTo] / ns;
      if (!wanted[to]) continue;
      edgesByHolder.set(holder, (edgesByHolder.get(holder) ?? 0) + 1);
      let set = targetsByHolder.get(holder);
      if (!set) {
        set = new Set();
        targetsByHolder.set(holder, set);
      }
      set.add(to);
    }
  }
  console.log(
    `${matched} objects match /${pattern}/; retained by (distinct targets, edges):`,
  );
  const rows = [...targetsByHolder].map(([h, set]) => [
    h,
    set.size,
    edgesByHolder.get(h),
  ]);
  for (const [holder, distinct, edgeCount] of rows
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)) {
    console.log(
      `${String(distinct).padStart(10)} ${String(edgeCount).padStart(10)}  ${holder.slice(0, 100)}`,
    );
  }
};

const analyze = (file, top) => {
  const s = readSnapshot(file);
  const fields = s.snapshot.meta.node_fields;
  const stride = fields.length;
  const nodes = s.nodes;
  const strings = s.strings;
  const types = s.snapshot.meta.node_types[0];
  const iType = fields.indexOf('type');
  const iName = fields.indexOf('name');
  const iSize = fields.indexOf('self_size');
  const byName = new Map();
  let total = 0;
  let count = 0;
  for (let i = 0; i < nodes.length; i += stride) {
    const key = `${types[nodes[i + iType]]} | ${strings[nodes[i + iName]]}`;
    const size = nodes[i + iSize];
    total += size;
    count += 1;
    const row = byName.get(key) ?? {n: 0, bytes: 0};
    row.n += 1;
    row.bytes += size;
    byName.set(key, row);
  }
  console.log(`${count} nodes, ${(total / 1048576).toFixed(1)} MiB`);
  console.log(`${'bytes'.padStart(12)} ${'count'.padStart(10)}  kind | name`);
  for (const [key, row] of [...byName]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, top)) {
    console.log(
      `${String(row.bytes).padStart(12)} ${String(row.n).padStart(10)}  ${key.slice(0, 110)}`,
    );
  }
};

if (mode === 'run') {
  const atClock = Number(flag('--at-clock', '0'));
  const out = flag('-o', join(root, 'perf-out', 'heap.heapsnapshot'));
  const entry = args[0];
  let taken = false;
  await compile(entry, (n) => {
    if (atClock > 0 && n === atClock && !taken) {
      taken = true;
      console.error(
        `snapshot at clock read ${n}: ${v8.writeHeapSnapshot(out)}`,
      );
    }
  });
  if (atClock === 0) {
    console.error(`snapshot after compile: ${v8.writeHeapSnapshot(out)}`);
  }
} else if (mode === 'clocks') {
  const entry = args[0];
  const t0 = performance.now();
  await compile(entry, (n, t) =>
    console.log(`clock ${n} at ${Math.round(t - t0)} ms`),
  );
} else if (mode === 'analyze') {
  const top = Number(flag('--top', '30'));
  analyze(args[0], top);
} else if (mode === 'retainers') {
  const top = Number(flag('--top', '25'));
  retainers(args[0], args[1], top);
} else {
  console.error(
    'usage: heap-snapshot.mjs run <entry> [--at-clock N] [-o file] | clocks <entry> | analyze <file> [--top N] | retainers <file> <name-regex> [--top N]',
  );
  process.exit(2);
}
