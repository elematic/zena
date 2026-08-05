/**
 * Download the real-world WIT corpus for checkouts that are not using Nix.
 *
 * Nix users get it via `nix develop`, which exports ZENA_WASI_WIT — this script
 * is the fallback, and both read the same pin in `wit-corpus.json`.
 *
 *   node dev/fetch-wit-corpus.js                 download + verify + extract
 *   node dev/fetch-wit-corpus.js --print-digest  recompute the content digest
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
} from './wit-corpus.js';

const args = process.argv.slice(2);
const printDigest = args.includes('--print-digest');
const force = args.includes('--force');

const manifest = await readManifest();

if (!printDigest && !force) {
  const existing = await findCorpus();
  if (existing != null) {
    const digest = await contentDigest(existing.dir);
    if (digest === manifest.contentDigest) {
      console.log(`✔ corpus already present at ${existing.source}`);
      process.exit(0);
    }
    console.log(
      `corpus at ${existing.source} does not match the pin; re-fetching`,
    );
  }
}

// Staged inside the package rather than $TMPDIR so the final rename is on one
// filesystem — /tmp is frequently a separate device, and rename across devices
// fails with EXDEV. Keeping it here also makes the swap atomic.
const scratch = await mkdtemp(join(pkgDir, '.wit-corpus.tmp-'));
try {
  console.log(`Downloading ${manifest.url}`);
  const res = await fetch(manifest.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${manifest.url}`);
  }
  const tarball = join(scratch, 'corpus.tar.gz');
  await writeFile(tarball, Buffer.from(await res.arrayBuffer()));

  // Node has no built-in tar reader; `tar` is present on Linux and macOS.
  const unpacked = join(scratch, 'unpacked');
  await mkdir(unpacked, {recursive: true});
  try {
    execFileSync('tar', ['xzf', tarball, '-C', unpacked], {stdio: 'pipe'});
  } catch (e) {
    throw new Error(
      `could not extract the archive with \`tar\`: ${String(e)}\n` +
        'On a system without tar, use `nix develop` instead.',
    );
  }

  // GitHub archives wrap everything in one <repo>-<commit> directory.
  const entries = await readdir(unpacked, {withFileTypes: true});
  const roots = entries.filter((e) => e.isDirectory());
  if (roots.length !== 1) {
    throw new Error(
      `expected exactly one top-level directory in the archive, got ${roots.length}`,
    );
  }
  const root = join(unpacked, roots[0].name);

  const digest = await contentDigest(root);
  if (printDigest) {
    console.log(digest);
    console.log(`\nPaste this as "contentDigest" in ${manifestPath}`);
    process.exit(0);
  }

  if (manifest.contentDigest == null) {
    throw new Error(
      'wit-corpus.json has no contentDigest. Compute it with:\n' +
        '  node dev/fetch-wit-corpus.js --print-digest',
    );
  }
  if (digest !== manifest.contentDigest) {
    throw new Error(
      'content digest mismatch — refusing to install this corpus.\n' +
        `  expected ${manifest.contentDigest}\n` +
        `  actual   ${digest}\n` +
        'If the pin was updated on purpose, refresh it with --print-digest.',
    );
  }

  await rm(localCorpusDir, {recursive: true, force: true});
  await rename(root, localCorpusDir);
  console.log(`✔ corpus verified and installed at .wit-corpus (${digest})`);
} finally {
  await rm(scratch, {recursive: true, force: true});
}
