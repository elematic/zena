/**
 * Production static file server for the built site.
 *
 * This is what runs in the container. It has no dependencies so the runtime
 * image can be `node:*-slim` plus `_site/` and nothing else -- no npm install,
 * no `node_modules`, no supply chain to audit.
 *
 * `server.js` is the dev server: it additionally rewrites bare module
 * specifiers via @zipadee/javascript. The built site has no bare specifiers
 * (esbuild bundles everything into /js/zena.js), so production doesn't need
 * that and this server doesn't do it.
 *
 * Run it directly with `npm run start -w @zena-lang/website` to exercise the
 * exact production server without Docker.
 */

import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createGzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(__dirname, '_site');
const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080;

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

// `application/wasm` is included deliberately: WebAssembly.instantiateStreaming
// rejects any other type, and lsp.wasm is the largest asset on the site.
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

/**
 * Resolve a request path to a file inside `_site`, or `undefined`.
 *
 * Returns `undefined` rather than throwing for anything that escapes the site
 * directory, so a malformed or hostile path is a 404 like any other miss.
 */
const resolveFile = async (urlPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined; // malformed percent-encoding
  }
  if (decoded.includes('\0')) {
    return undefined;
  }

  // Resolving against the site root collapses `..` segments; the prefix check
  // below then rejects anything that climbed out.
  const resolved = path.resolve(siteDir, '.' + path.posix.normalize(decoded));
  if (resolved !== siteDir && !resolved.startsWith(siteDir + path.sep)) {
    return undefined;
  }

  const candidates = [resolved];
  // Eleventy writes `guide/why-zena/index.html`, reached as `/guide/why-zena/`.
  if (path.extname(resolved) === '') {
    candidates.push(path.join(resolved, 'index.html'));
  }

  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate);
      if (stats.isFile()) {
        return {file: candidate, size: stats.size, mtime: stats.mtime};
      }
      if (stats.isDirectory()) {
        const index = path.join(candidate, 'index.html');
        const indexStats = await stat(index);
        if (indexStats.isFile()) {
          return {file: index, size: indexStats.size, mtime: indexStats.mtime};
        }
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
};

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {allow: 'GET, HEAD'}).end('Method Not Allowed');
    return;
  }

  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const found = await resolveFile(urlPath);

  if (found === undefined) {
    const notFound = await resolveFile('/404.html');
    if (notFound !== undefined) {
      res.writeHead(404, {'content-type': 'text/html; charset=utf-8'});
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      await pipeline(createReadStream(notFound.file), res).catch(() => {});
      return;
    }
    res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
    res.end('Not Found');
    return;
  }

  // `no-cache` means revalidate, not "don't store", so browsers re-request
  // every asset on reload. Answering 304 keeps that from re-sending lsp.wasm
  // (3MB) and zena.js (1MB) each time. Compared at second granularity because
  // that is all the header carries.
  const ifModifiedSince = Date.parse(req.headers['if-modified-since'] ?? '');
  if (
    !Number.isNaN(ifModifiedSince) &&
    Math.floor(found.mtime.getTime() / 1000) <=
      Math.floor(ifModifiedSince / 1000)
  ) {
    res.writeHead(304, {'last-modified': found.mtime.toUTCString()}).end();
    return;
  }

  const ext = path.extname(found.file);
  const headers = {
    'content-type': CONTENT_TYPES.get(ext) ?? 'application/octet-stream',
    // Assets are not content-hashed, so revalidate rather than cache. Testers
    // get the current build on reload instead of a stale playground.
    'cache-control': 'no-cache',
    'last-modified': found.mtime.toUTCString(),
    vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff',
  };

  const acceptsGzip = (req.headers['accept-encoding'] ?? '').includes('gzip');
  const compress = acceptsGzip && COMPRESSIBLE.has(ext) && found.size > 1024;

  if (compress) {
    headers['content-encoding'] = 'gzip';
  } else {
    headers['content-length'] = String(found.size);
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const source = createReadStream(found.file);
  try {
    if (compress) {
      await pipeline(source, createGzip(), res);
    } else {
      await pipeline(source, res);
    }
  } catch (error) {
    // Client disconnects are routine; anything else is worth seeing in logs.
    if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error(`Error serving ${found.file}:`, error);
    }
    res.destroy();
  }
});

server.listen(port, () => {
  console.log(`server running at http://localhost:${port}`);
  console.log(`serving ${siteDir}`);
});

// This process is PID 1 in the container, and Linux delivers a signal to PID 1
// only when a handler is installed for it. Node otherwise relies on the default
// disposition for SIGINT and SIGTERM, which the kernel suppresses for PID 1, so
// without these the process ignores both: Ctrl-C does nothing and Cloud Run
// SIGKILLs the instance after its grace period instead of shutting it down.
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  // Idle keep-alive sockets would hold the server open past the point anyone is
  // waiting. Cloud Run allows around 10s after SIGTERM; don't spend all of it.
  server.closeIdleConnections();
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, 3000).unref();
};

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}
