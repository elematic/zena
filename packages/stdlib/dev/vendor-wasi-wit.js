/**
 * Vendor the WASI 0.3 WIT into `zena/wit/` from the pinned corpus.
 *
 * The corpus is the one `packages/wit-parser/dev/wit-corpus.json` pins: its
 * `wasi` source is the WebAssembly/WASI repository at the 0.3.0
 * release, fetched by `nix develop` (ZENA_WASI_WIT) or by
 * `node packages/wit-parser/dev/fetch-wit-corpus.js`. Each proposal's
 * `wit/` directory becomes one file here, `zena/wit/<proposal>.wit`:
 * the proposal's files in name order, under a single package header,
 * because upstream puts the header in only some files and the
 * compiler's host reads a WIT root as its files concatenated in name
 * order — a header-less file would join whichever package sorted
 * before it.
 *
 *   node dev/vendor-wasi-wit.js          rewrite zena/wit/ from the corpus
 *   node dev/vendor-wasi-wit.js --check  fail if zena/wit/ differs from it
 *
 * The check runs with the stdlib's tests, so the vendored tree cannot
 * drift from the pin: bumping the pin means re-running this script.
 */
import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  findCorpus,
  MISSING_CORPUS_MESSAGE,
  readManifest,
  verifyCorpus,
} from '../../wit-parser/dev/wit-corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stdlibDir = join(__dirname, '..');
const outDir = join(stdlibDir, 'zena', 'wit');

/** The proposals vendored, each `proposals/<name>/wit` upstream. */
const PROPOSALS = ['cli', 'clocks', 'filesystem', 'http', 'random', 'sockets'];

const check = process.argv.includes('--check');

const corpus = await findCorpus();
if (corpus == null) {
  console.error(MISSING_CORPUS_MESSAGE);
  process.exit(1);
}
const manifest = await readManifest();
const problems = await verifyCorpus(corpus.dir, manifest);
if (problems.length > 0) {
  console.error(`✗ corpus at ${corpus.source} does not match wit-corpus.json`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const wasi = manifest.sources.wasi;
const wasiRoot = join(corpus.dir, 'wasi');

/** `package ns:name@version;` at the head of a file, or null. */
const headerOf = (text) => {
  const m = text.match(/^package\s+([^\s;{]+)\s*;\s*$/m);
  return m == null ? null : m[1];
};

/** One proposal's vendored file: its files in name order under one header. */
const render = async (proposal) => {
  const dir = join(wasiRoot, 'proposals', proposal, 'wit');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.wit')).sort();
  let pkg = null;
  const parts = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf-8');
    const header = headerOf(text);
    if (header != null) {
      if (pkg != null && header !== pkg) {
        throw new Error(
          `${proposal}/${name} declares ${header}, and an earlier file ${pkg}`,
        );
      }
      pkg = header;
    }
    // The header line goes; everything else is kept as upstream wrote it.
    const body = text.replace(/^package\s+[^\s;{]+\s*;[ \t]*\n?/m, '');
    parts.push(`// ---- ${name}\n\n${body.trim()}\n`);
  }
  if (pkg == null) {
    throw new Error(
      `no file under proposals/${proposal}/wit declares a package`,
    );
  }
  // The provenance comment follows the header: a comment before a
  // `package` line reads as that package's doc comment, and a document
  // concatenated from several files may carry one package's docs once.
  const provenance =
    `// Vendored from WebAssembly/WASI ${wasi.ref} ` +
    `(proposals/${proposal}/wit), by dev/vendor-wasi-wit.js. Do not\n` +
    `// edit: re-run the script against the pinned corpus instead.\n`;
  return `package ${pkg};\n${provenance}\n${parts.join('\n')}`;
};

let differs = false;
await mkdir(outDir, {recursive: true});
for (const proposal of PROPOSALS) {
  const expected = await render(proposal);
  const out = join(outDir, `${proposal}.wit`);
  const shown = relative(stdlibDir, out);
  if (check) {
    let actual = null;
    try {
      actual = await readFile(out, 'utf-8');
    } catch {
      // Missing counts as different.
    }
    if (actual !== expected) {
      console.error(`✗ ${shown} differs from the pinned corpus`);
      differs = true;
    }
  } else {
    await writeFile(out, expected);
    console.log(`wrote ${shown}`);
  }
}
if (check) {
  if (differs) {
    console.error('  Re-run: node packages/stdlib/dev/vendor-wasi-wit.js');
    process.exit(1);
  }
  console.log(`✔ zena/wit matches the pinned corpus (${wasi.ref})`);
}
