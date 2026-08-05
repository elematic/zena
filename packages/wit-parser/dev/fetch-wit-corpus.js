/**
 * Download the real-world WIT corpus for checkouts that are not using Nix.
 *
 * Nix users get it via `nix develop`, which exports ZENA_WASI_WIT — this script
 * is the fallback, and both read the same pins in `wit-corpus.json` and produce
 * the same `<root>/<source-name>/…` layout.
 *
 *   node dev/fetch-wit-corpus.js                 download + verify + extract
 *   node dev/fetch-wit-corpus.js --print-digest  recompute the content digests
 *   node dev/fetch-wit-corpus.js --force         re-download over an existing copy
 */
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, readdir, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {
  contentDigest,
  findCorpus,
  localCorpusDir,
  manifestPath,
  pkgDir,
  readManifest,
  verifyCorpus,
} from './wit-corpus.js';

const args = process.argv.slice(2);
const printDigest = args.includes('--print-digest');
const force = args.includes('--force');

const manifest = await readManifest();

if (!printDigest && !force) {
  const existing = await findCorpus();
  if (
    existing != null &&
    (await verifyCorpus(existing.dir, manifest)).length === 0
  ) {
    console.log(`✔ corpus already present at ${existing.source}`);
    process.exit(0);
  }
  if (existing != null) {
    console.log(
      `corpus at ${existing.source} is incomplete or stale; re-fetching`,
    );
  }
}

/** Download one source, extract it, and return the extracted root. */
const fetchSource = async (name, src, scratch) => {
  console.log(`Downloading ${name}: ${src.url}`);
  const res = await fetch(src.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${src.url}`);
  }
  const tarball = join(scratch, `${name}.tar.gz`);
  await writeFile(tarball, Buffer.from(await res.arrayBuffer()));

  // Node has no built-in tar reader; `tar` is present on Linux and macOS.
  const unpacked = join(scratch, `${name}-unpacked`);
  await mkdir(unpacked, {recursive: true});
  try {
    execFileSync('tar', ['xzf', tarball, '-C', unpacked], {stdio: 'pipe'});
  } catch (e) {
    throw new Error(
      `could not extract ${name} with \`tar\`: ${String(e)}\n` +
        'On a system without tar, use `nix develop` instead.',
    );
  }

  // GitHub archives wrap everything in one <repo>-<ref> directory.
  const roots = (await readdir(unpacked, {withFileTypes: true})).filter((e) =>
    e.isDirectory(),
  );
  if (roots.length !== 1) {
    throw new Error(
      `expected exactly one top-level directory in ${name}, got ${roots.length}`,
    );
  }
  return join(unpacked, roots[0].name);
};

// Staged inside the package rather than $TMPDIR so the final rename is on one
// filesystem — /tmp is frequently a separate device, and rename across devices
// fails with EXDEV. Keeping it here also makes the swap atomic.
const scratch = await mkdtemp(join(pkgDir, '.wit-corpus.tmp-'));
try {
  const staged = join(scratch, 'staged');
  await mkdir(staged, {recursive: true});
  const digests = {};

  for (const [name, src] of Object.entries(manifest.sources)) {
    const root = await fetchSource(name, src, scratch);
    digests[name] = await contentDigest(root);

    if (!printDigest) {
      if (src.contentDigest == null) {
        throw new Error(
          `source \`${name}\` has no contentDigest in wit-corpus.json.\n` +
            'Compute it with: node dev/fetch-wit-corpus.js --print-digest',
        );
      }
      if (digests[name] !== src.contentDigest) {
        throw new Error(
          `content digest mismatch for \`${name}\` — refusing to install it.\n` +
            `  expected ${src.contentDigest}\n` +
            `  actual   ${digests[name]}\n` +
            'If the pin was updated on purpose, refresh it with --print-digest.',
        );
      }
    }
    await rename(root, join(staged, name));
  }

  if (printDigest) {
    for (const [name, digest] of Object.entries(digests)) {
      console.log(`${name}: ${digest}`);
    }
    console.log(`\nPaste these as "contentDigest" in ${manifestPath}`);
    process.exit(0);
  }

  await rm(localCorpusDir, {recursive: true, force: true});
  await rename(staged, localCorpusDir);
  console.log(
    '✔ corpus verified and installed at .wit-corpus ' +
      `(${Object.keys(manifest.sources).join(', ')})`,
  );
} finally {
  await rm(scratch, {recursive: true, force: true});
}
