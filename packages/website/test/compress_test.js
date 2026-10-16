import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {brotliDecompressSync, gunzipSync} from 'node:zlib';
import {compressSite} from '../lib/compress.js';

describe('compressSite', () => {
  it('writes .gz and .br sidecars for compressible files above minSize', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zena-compress-test-'));
    try {
      const htmlContent = '<h1>Hello Zena</h1>\n'.repeat(100);
      const smallContent = 'tiny';
      const pngContent = Buffer.alloc(2048, 0x42);

      await writeFile(join(dir, 'index.html'), htmlContent);
      await writeFile(join(dir, 'small.html'), smallContent);
      await writeFile(join(dir, 'logo.png'), pngContent);

      const count = await compressSite(dir);
      assert.equal(count, 1);

      const gzBytes = await readFile(join(dir, 'index.html.gz'));
      const brBytes = await readFile(join(dir, 'index.html.br'));
      assert.equal(gunzipSync(gzBytes).toString('utf8'), htmlContent);
      assert.equal(brotliDecompressSync(brBytes).toString('utf8'), htmlContent);

      await assert.rejects(stat(join(dir, 'small.html.gz')));
      await assert.rejects(stat(join(dir, 'logo.png.gz')));
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
