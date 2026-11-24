/**
 * Zero-dependency local HTTP server for the ZenaFX web runner demo.
 *
 * Serves the repository root (for `/packages/zenafx/out/*.wasm`,
 * `/packages/zenafx-web/out/zenafx_web_engine.wasm`, and `/packages/zenafx-web/src/*.js`)
 * plus a bundled system font at `/packages/zenafx-web/demo/font.ttf`.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync} from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const PORT = Number(process.env.PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
};

const OPEN_SANS_FONT = path.join(
  repoRoot,
  'node_modules/@radica/base/fonts/Open Sans/Open_Sans/OpenSans-VariableFont_wdth,wght.ttf',
);

const findSystemFont = () => {
  if (
    process.env.ZENAFX_WEB_FONT &&
    fs.existsSync(process.env.ZENAFX_WEB_FONT)
  ) {
    return process.env.ZENAFX_WEB_FONT;
  }
  const bundled = path.join(__dirname, 'font.ttf');
  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync(OPEN_SANS_FONT)) return OPEN_SANS_FONT;
  try {
    const out = execSync('fc-match -f "%{file}" sans-serif', {
      encoding: 'utf8',
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // ignore
  }
  for (const candidate of [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial.ttf',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const fontPath = findSystemFont();

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (urlPath === '/' || urlPath === '/packages/zenafx-web/demo') {
    res.writeHead(302, {Location: '/packages/zenafx-web/demo/index.html'});
    res.end();
    return;
  }

  if (urlPath === '/packages/zenafx-web/demo/font.ttf') {
    if (!fontPath) {
      res.writeHead(404);
      res.end('No system sans-serif font found; set ZENAFX_WEB_FONT=/path/to/font.ttf');
      return;
    }
    res.writeHead(200, {'Content-Type': 'font/ttf'});
    fs.createReadStream(fontPath).pipe(res);
    return;
  }

  const fullPath = path.resolve(repoRoot, `.${urlPath}`);
  if (!fullPath.startsWith(repoRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end(`Not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(fullPath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `ZenaFX Web Demo listening on http://127.0.0.1:${PORT}/packages/zenafx-web/demo/index.html`,
  );
  if (fontPath) {
    console.log(`Font: ${fontPath}`);
  }
});
