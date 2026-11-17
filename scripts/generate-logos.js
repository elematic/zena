#!/usr/bin/env node
/**
 * Generates boxed SVG and PNG logo variants from `assets/zena.svg`:
 *
 * - `assets/logo.svg`, `assets/logo.png` (512x512, blue gradient box, white mark)
 * - `assets/logo-black.svg`, `assets/logo-black.png` (512x512, black box, white mark)
 * - `assets/logo-white.svg`, `assets/logo-white.png` (512x512, white box, black mark)
 * - `packages/website/src/public/logo.svg` (512x512, blue gradient box, white mark)
 * - `packages/website/src/public/favicon.svg` (32x32, blue gradient box, white mark)
 *
 * Pass `--check` to verify that every generated file matches `assets/zena.svg`
 * without writing to disk.
 */

import {initWasm, Resvg} from '@resvg/resvg-wasm';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const sourcePath = join(repoRoot, 'assets', 'zena.svg');

const BOX_CORNER_RATIO = 8 / 32;
const BOX_PADDING_RATIO = 3.5 / 32;

const formatNumber = (value) => Number(value.toFixed(6)).toString();

const replaceLogoColorVar = (markup, color) => {
  const prefix = 'var(--zena-logo-color';
  let result = '';
  let index = 0;
  while (index < markup.length) {
    const start = markup.indexOf(prefix, index);
    if (start === -1) {
      result += markup.slice(index);
      break;
    }
    result += markup.slice(index, start);
    let depth = 0;
    let cursor = start;
    while (cursor < markup.length) {
      const ch = markup[cursor];
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          cursor += 1;
          break;
        }
      }
      cursor += 1;
    }
    result += color;
    index = cursor;
  }
  return result;
};

const reindent = (markup, spaces) => {
  const rawLines = markup.replace(/^\n+|\n+\s*$/g, '').split('\n');
  let minIndent = Infinity;
  for (const line of rawLines) {
    if (line.trim() === '') continue;
    const match = line.match(/^ */);
    minIndent = Math.min(minIndent, match[0].length);
  }
  const strip = Number.isFinite(minIndent) ? minIndent : 0;
  const pad = ' '.repeat(spaces);
  return rawLines
    .map((line) => (line.trim() === '' ? '' : pad + line.slice(strip)))
    .join('\n');
};

export const parseSourceMark = (svgText) => {
  const svgMatch = svgText.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/);
  if (!svgMatch) {
    throw new Error(`Could not find root <svg> element in ${sourcePath}`);
  }
  const vbMatch = svgMatch[1].match(/\bviewBox="([^"]+)"/);
  if (!vbMatch) {
    throw new Error(`Missing viewBox attribute in ${sourcePath}`);
  }
  const parts = vbMatch[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isFinite(n)) ||
    parts[2] <= 0 ||
    parts[3] <= 0
  ) {
    throw new Error(`Invalid viewBox="${vbMatch[1]}" in ${sourcePath}`);
  }
  const [minX, minY, width, height] = parts;

  let body = svgMatch[2].trim();
  const outerGroup = body.match(
    /^<g\s+fill="var\(--zena-logo-color\b[^"]*"\s*>([\s\S]*)<\/g>$/,
  );
  if (outerGroup && !outerGroup[1].includes('</g>')) {
    body = outerGroup[1];
  }
  return {minX, minY, width, height, body};
};

export const buildBoxedSvg = (mark, {size, background, foreground}) => {
  const rx = formatNumber(size * BOX_CORNER_RATIO);
  const padding = size * BOX_PADDING_RATIO;
  const innerSize = size - 2 * padding;
  const scale = innerSize / Math.max(mark.width, mark.height);
  const offsetX =
    padding + (innerSize - mark.width * scale) / 2 - mark.minX * scale;
  const offsetY =
    padding + (innerSize - mark.height * scale) / 2 - mark.minY * scale;

  const transform = `translate(${formatNumber(offsetX)} ${formatNumber(offsetY)}) scale(${formatNumber(scale)})`;
  const innerMarkup = reindent(replaceLogoColorVar(mark.body, foreground), 4);

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Zena">`,
  ];
  if (background.type === 'gradient') {
    lines.push(
      '  <defs>',
      '    <linearGradient id="z" x1="0" y1="0" x2="1" y2="1">',
      `      <stop offset="0" stop-color="${background.from}" />`,
      `      <stop offset="1" stop-color="${background.to}" />`,
      '    </linearGradient>',
      '  </defs>',
      `  <rect width="${size}" height="${size}" rx="${rx}" fill="url(#z)" />`,
    );
  } else {
    lines.push(
      `  <rect width="${size}" height="${size}" rx="${rx}" fill="${background.color}" />`,
    );
  }
  lines.push(
    `  <g transform="${transform}" fill="${foreground}">`,
    innerMarkup,
    '  </g>',
    '</svg>',
    '',
  );
  return lines.join('\n');
};

const renderPng = (svg, size) => {
  const resvg = new Resvg(svg, {
    fitTo: {mode: 'width', value: size},
    font: {loadSystemFonts: false},
  });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  rendered.free();
  resvg.free();
  return png;
};

let wasmInitialized = false;
const ensureWasm = async () => {
  if (wasmInitialized) return;
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@resvg/resvg-wasm/index_bg.wasm');
  await initWasm(readFileSync(wasmPath));
  wasmInitialized = true;
};

export const generateLogoAssets = async (
  sourceSvgText = readFileSync(sourcePath, 'utf8'),
) => {
  await ensureWasm();
  const mark = parseSourceMark(sourceSvgText);
  const blueGradient = {type: 'gradient', from: '#6366f1', to: '#22d3ee'};
  const logo512Svg = buildBoxedSvg(mark, {
    size: 512,
    background: blueGradient,
    foreground: '#ffffff',
  });
  const logoBlackSvg = buildBoxedSvg(mark, {
    size: 512,
    background: {type: 'solid', color: '#000000'},
    foreground: '#ffffff',
  });
  const logoWhiteSvg = buildBoxedSvg(mark, {
    size: 512,
    background: {type: 'solid', color: '#ffffff'},
    foreground: '#000000',
  });
  const favicon32Svg = buildBoxedSvg(mark, {
    size: 32,
    background: blueGradient,
    foreground: '#ffffff',
  });

  return [
    {path: 'assets/logo.svg', content: Buffer.from(logo512Svg, 'utf8')},
    {path: 'assets/logo.png', content: renderPng(logo512Svg, 512)},
    {path: 'assets/logo-black.svg', content: Buffer.from(logoBlackSvg, 'utf8')},
    {path: 'assets/logo-black.png', content: renderPng(logoBlackSvg, 512)},
    {path: 'assets/logo-white.svg', content: Buffer.from(logoWhiteSvg, 'utf8')},
    {path: 'assets/logo-white.png', content: renderPng(logoWhiteSvg, 512)},
    {
      path: 'packages/website/src/public/logo.svg',
      content: Buffer.from(logo512Svg, 'utf8'),
    },
    {
      path: 'packages/website/src/public/favicon.svg',
      content: Buffer.from(favicon32Svg, 'utf8'),
    },
  ];
};

if (import.meta.main) {
  const checkOnly = process.argv.includes('--check');
  const outputs = await generateLogoAssets();

  const stale = [];
  for (const {path: relPath, content} of outputs) {
    const fullPath = join(repoRoot, relPath);
    if (checkOnly) {
      if (!existsSync(fullPath) || !readFileSync(fullPath).equals(content)) {
        stale.push(relative(repoRoot, fullPath));
      }
    } else {
      mkdirSync(dirname(fullPath), {recursive: true});
      writeFileSync(fullPath, content);
      console.log(`wrote ${relPath} (${content.length} bytes)`);
    }
  }

  if (checkOnly && stale.length > 0) {
    for (const relPath of stale) {
      console.error(
        `stale logo asset: ${relPath} (run \`npm run generate:logos\`)`,
      );
    }
    process.exit(1);
  }
}
