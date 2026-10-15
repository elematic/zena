import {readdir, readFile, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {promisify} from 'node:util';
import {brotliCompress as brotliCb, constants, gzip as gzipCb} from 'node:zlib';

const gzip = promisify(gzipCb);
const brotli = promisify(brotliCb);

// Matches the compressible set from serve-static.js, including .wasm (lsp.wasm
// is the largest asset on the site).
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.map',
  '.svg',
  '.wasm',
  '.txt',
  '.xml',
]);

const MIN_SIZE = 1024;
const CONCURRENCY = 8;

/**
 * Generates `.br` and `.gz` sidecar files for compressible assets under `dir`
 * so `zena:http`'s `serve()` can stream them zero-copy without runtime
 * compression overhead.
 */
export const compressSite = async (dir, {minSize = MIN_SIZE} = {}) => {
  const entries = await readdir(dir, {withFileTypes: true, recursive: true});
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (!COMPRESSIBLE.has(ext)) continue;
    files.push(join(entry.parentPath ?? entry.path, entry.name));
  }

  let compressedCount = 0;
  let index = 0;

  const worker = async () => {
    while (index < files.length) {
      const file = files[index++];
      const source = await readFile(file);
      if (source.byteLength < minSize) continue;

      const [gzBytes, brBytes] = await Promise.all([
        gzip(source, {level: constants.Z_BEST_COMPRESSION}),
        brotli(source, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 6,
            [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
          },
        }),
      ]);

      const writes = [];
      if (gzBytes.byteLength < source.byteLength) {
        writes.push(writeFile(`${file}.gz`, gzBytes));
      }
      if (brBytes.byteLength < source.byteLength) {
        writes.push(writeFile(`${file}.br`, brBytes));
      }
      if (writes.length > 0) {
        await Promise.all(writes);
        compressedCount++;
      }
    }
  };

  await Promise.all(
    Array.from({length: Math.min(CONCURRENCY, files.length)}, () => worker()),
  );
  return compressedCount;
};
