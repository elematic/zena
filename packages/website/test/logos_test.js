import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {suite, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  buildBoxedSvg,
  generateLogoAssets,
  parseSourceMark,
} from '../../../scripts/generate-logos.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const readPngDimensions = (buf) => {
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'expected PNG signature');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
};

suite('logo assets', () => {
  test('checked-in SVG and PNG logo assets match assets/zena.svg', async () => {
    const outputs = await generateLogoAssets();
    assert.equal(outputs.length, 8);
    for (const {path, content} of outputs) {
      const onDisk = readFileSync(join(repoRoot, path));
      assert.ok(
        onDisk.equals(content),
        `${path} is out of date with assets/zena.svg; run \`npm run generate:logos\``,
      );
    }
  });

  test('512x512 PNG variants have 512x512 RGBA headers', async () => {
    const outputs = await generateLogoAssets();
    const pngs = outputs.filter(({path}) => path.endsWith('.png'));
    assert.equal(pngs.length, 3);
    for (const {path, content} of pngs) {
      assert.deepEqual(
        readPngDimensions(content),
        {width: 512, height: 512, bitDepth: 8, colorType: 6},
        path,
      );
    }
  });

  test('re-scales and recolors arbitrary source mark geometry', () => {
    const sampleSource = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 100 50">',
      '  <path d="M10 20H110V70Z" fill="var(--zena-logo-color, oklch(0.5 0.2 270))" />',
      '</svg>',
    ].join('\n');
    const mark = parseSourceMark(sampleSource);
    assert.equal(mark.minX, 10);
    assert.equal(mark.minY, 20);
    assert.equal(mark.width, 100);
    assert.equal(mark.height, 50);

    const boxed = buildBoxedSvg(mark, {
      size: 512,
      background: {type: 'solid', color: '#000000'},
      foreground: '#ffffff',
    });
    assert.match(boxed, /viewBox="0 0 512 512" width="512" height="512"/);
    assert.match(
      boxed,
      /<rect width="512" height="512" rx="128" fill="#000000" \/>/,
    );
    assert.match(boxed, /<path d="M10 20H110V70Z" fill="#ffffff" \/>/);
  });
});
