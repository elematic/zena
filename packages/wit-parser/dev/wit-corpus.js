/**
 * Locating and verifying the real-world WIT corpus.
 *
 * The corpus is third-party WIT with its own license, so it is not vendored.
 * It reaches a checkout one of two ways, and this module is what both the
 * fetcher and the tests use to agree on where it landed:
 *
 *   Nix     `nix develop` exports ZENA_WASI_WIT, pointing at a fetchzip'd
 *           store path. Read-only, already verified by Nix, no network.
 *   No Nix  `node dev/fetch-wit-corpus.js` downloads and extracts it into
 *           `.wit-corpus/` (gitignored) next to this package.
 *
 * Both are pinned by `wit-corpus.json`.
 */
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const pkgDir = join(__dirname, '..');
export const manifestPath = join(pkgDir, 'wit-corpus.json');
export const localCorpusDir = join(pkgDir, '.wit-corpus');

export const readManifest = async () =>
  JSON.parse(await readFile(manifestPath, 'utf-8'));

/** Every .wit file under `dir`, as repo-relative paths, sorted. */
export const witFilesUnder = async (dir) => {
  const found = [];
  const walk = async (cur) => {
    for (const entry of await readdir(cur, {withFileTypes: true})) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.wit')) found.push(full);
    }
  };
  await walk(dir);
  return found.map((f) => relative(dir, f)).sort();
};

/**
 * A digest of the corpus's *content*, independent of how it was packaged.
 *
 * Hashing the tarball instead would be brittle: GitHub regenerates archives and
 * the gzip framing changes even when no file does, which would fail the check
 * for a corpus that is in fact correct.
 */
export const contentDigest = async (dir) => {
  const hash = createHash('sha256');
  for (const rel of await witFilesUnder(dir)) {
    const bytes = await readFile(join(dir, rel));
    hash.update(`${rel} ${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
};

const exists = async (p) => {
  try {
    await readdir(p);
    return true;
  } catch {
    return false;
  }
};

export const MISSING_CORPUS_MESSAGE = `The real-world WIT corpus is not present.

It is third-party WIT with its own license, so it is not checked in. Get it with
either:

  nix develop                     (exports ZENA_WASI_WIT; no download needed)
  node dev/fetch-wit-corpus.js    (downloads to .wit-corpus/, needs network)

Both are pinned by packages/wit-parser/wit-corpus.json.`;

/**
 * Where the corpus is, or `null`. Callers are expected to fail loudly rather
 * than skip — a silently-skipped check reads exactly like a passing one.
 */
export const findCorpus = async () => {
  const fromNix = process.env.ZENA_WASI_WIT;
  if (fromNix != null && fromNix !== '' && (await exists(fromNix))) {
    return {dir: fromNix, source: 'ZENA_WASI_WIT (nix)'};
  }
  if (await exists(localCorpusDir)) {
    return {dir: localCorpusDir, source: relative(pkgDir, localCorpusDir)};
  }
  return null;
};
