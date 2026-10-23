/**
 * Preview Service Worker for `<zena-preview>`.
 *
 * Intercepts requests under `{scope}{sessionId}/{filePath}`, serves project
 * files from the main window via Supertalk `FileAPI`, serves virtual
 * `node_modules/` packages via `CdnModuleRegistry`, and rewrites bare module
 * specifiers in both project and CDN `.js` files with `BareModuleTransformer`.
 */

import {expose} from 'supertalk';
import type {
  FileAPI,
  ServiceWorkerAPI,
  ServiceWorkerMessage,
} from '../preview-shared/service-worker-api.js';
import {INIT, MISSING_FILE_API} from '../preview-shared/service-worker-api.js';
import {serviceWorkerHash} from '../preview-shared/versions.js';
import {BareModuleTransformer} from './bare-module-transformer.js';
import {CdnModuleRegistry} from './cdn-module-registry.js';
import {parseNpmStyleSpecifier} from './util.js';

interface ServiceWorkerClient {
  readonly url: string;
  postMessage(message: unknown): void;
}

interface ServiceWorkerClients {
  matchAll(options?: {
    includeUncontrolled?: boolean;
  }): Promise<ReadonlyArray<ServiceWorkerClient>>;
  claim(): Promise<void>;
}

interface ExtendableEvent extends Event {
  waitUntil(f: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}

interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: ServiceWorkerMessage;
}

declare const self: {
  readonly registration: {readonly scope: string};
  readonly clients: ServiceWorkerClients;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'fetch', listener: (e: FetchEvent) => void): void;
  addEventListener(
    type: 'activate' | 'install',
    listener: (e: ExtendableEvent) => void,
  ): void;
  addEventListener(
    type: 'message',
    listener: (e: ExtendableMessageEvent) => void,
  ): void;
};

type SessionID = string;

const fileAPIs = new Map<SessionID, PromiseWithResolvers<FileAPI>>();

let registry: CdnModuleRegistry | undefined;
let bareModuleTransformer: BareModuleTransformer | undefined;

const getTransformer = (): {
  registry: CdnModuleRegistry;
  transformer: BareModuleTransformer;
} => {
  if (!registry || !bareModuleTransformer) {
    const scope = self.registration.scope;
    registry = new CdnModuleRegistry('https://cdn.jsdelivr.net/npm/', {
      localPackages: {
        '@zena-lang/runtime': {
          packageJson: {
            name: '@zena-lang/runtime',
            version: '0.0.1',
            type: 'module',
            exports: {
              '.': './index.js',
            },
          },
          files: {
            'index.js': new URL('vendor/zena-runtime.js', scope).href,
          },
        },
        '@zena-lang/wasm-web-ui': {
          packageJson: {
            name: '@zena-lang/wasm-web-ui',
            version: '0.0.1',
            type: 'module',
            exports: {
              '.': './index.js',
            },
            dependencies: {
              'lit-html': '^3.3.0',
            },
          },
          files: {
            'index.js': new URL('vendor/wasm-web-ui.js', scope).href,
          },
        },
        'lit-html': {
          packageJson: {
            name: 'lit-html',
            version: '3.3.0',
            type: 'module',
            exports: {
              '.': './index.js',
              './lit-html.js': './index.js',
            },
          },
          files: {
            'index.js': new URL('vendor/lit-html.js', scope).href,
          },
        },
      },
    });
    bareModuleTransformer = new BareModuleTransformer(registry);
  }
  return {registry, transformer: bareModuleTransformer};
};

const workerAPI: ServiceWorkerAPI = {
  async setFileAPI(fileAPI: FileAPI, sessionID: SessionID) {
    let deferred = fileAPIs.get(sessionID);
    if (deferred === undefined) {
      deferred = Promise.withResolvers();
      fileAPIs.set(sessionID, deferred);
    }
    deferred.resolve(fileAPI);
  },
  async getHash() {
    return serviceWorkerHash;
  },
};

const findSessionProxyClient = async (
  sessionId: string,
): Promise<ServiceWorkerClient | undefined> => {
  for (const client of await self.clients.matchAll({
    includeUncontrolled: true,
  })) {
    const hash = new URL(client.url).hash;
    const hashParams = new URLSearchParams(hash.slice(1));
    if (hashParams.get('session-id') === sessionId) {
      return client;
    }
  }
  return undefined;
};

const getFileApi = async (sessionId: string): Promise<FileAPI | undefined> => {
  let deferred = fileAPIs.get(sessionId);
  if (deferred !== undefined) {
    return deferred.promise;
  }
  const client = await findSessionProxyClient(sessionId);
  if (client === undefined) {
    return undefined;
  }
  deferred = Promise.withResolvers();
  fileAPIs.set(sessionId, deferred);
  const missingMessage: ServiceWorkerMessage = {type: MISSING_FILE_API};
  client.postMessage(missingMessage);
  return deferred.promise;
};

const makeHeaders = (contentType?: string): Headers => {
  const headers = new Headers();
  headers.set('Origin-Agent-Cluster', '?1');
  if (contentType) {
    headers.set('Content-Type', contentType);
  }
  return headers;
};

const serveNodeModule = async (path: string): Promise<Response> => {
  const npmPath = path.slice('node_modules/'.length);
  const location = parseNpmStyleSpecifier(npmPath);
  if (location === undefined) {
    return new Response('Not Found', {status: 404});
  }
  try {
    const {registry, transformer} = getTransformer();
    const [cdnFile, pkgJson] = await Promise.all([
      registry.fetch(location),
      registry.fetchPackageJson(location),
    ]);
    const transformed = await transformer.transformModule(
      {
        name: path,
        content: cdnFile.content,
        contentType: cdnFile.contentType,
      },
      pkgJson,
    );
    return new Response(transformed.content, {
      headers: makeHeaders(
        transformed.contentType ?? 'application/javascript; charset=utf-8',
      ),
    });
  } catch (e) {
    return new Response(
      `Failed to load module ${npmPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      {status: 500},
    );
  }
};

const injectConsoleBridge = (html: string, sessionId: string): string => {
  const script = `<script>(() => {
  const sessionId = ${JSON.stringify(sessionId)};
  const formatArg = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message || String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const send = (level, args) => {
    try {
      window.parent.postMessage({
        type: 'zena-preview-console',
        sessionId,
        level,
        message: args.map(formatArg).join(' '),
      }, '*');
    } catch {}
  };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      send(level, args);
    };
  }
  window.addEventListener('error', (e) => {
    send('error', [e.error || e.message || 'Uncaught error']);
  });
  window.addEventListener('unhandledrejection', (e) => {
    send('error', ['Unhandled promise rejection:', e.reason]);
  });
})();</script>`;

  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }
  const bodyMatch = /<body\b[^>]*>/i.exec(html);
  if (bodyMatch) {
    const idx = bodyMatch.index + bodyMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }
  return script + html;
};

const getFile = async (
  _e: FetchEvent,
  path: string,
  sessionId: SessionID,
): Promise<Response> => {
  if (path.startsWith('node_modules/')) {
    return serveNodeModule(path);
  }

  const fileAPI = await getFileApi(sessionId);
  if (fileAPI === undefined) {
    return new Response('No file API', {
      status: /* Service Unavailable */ 503,
    });
  }

  const fileOrError = await fileAPI.getFile(path);
  if ('status' in fileOrError) {
    const {body, status} = fileOrError;
    return new Response(body, {status});
  }

  let {content, contentType} = fileOrError;
  if (
    typeof content === 'string' &&
    (path.endsWith('.js') || path.endsWith('.mjs'))
  ) {
    const {transformer} = getTransformer();
    const transformed = await transformer.transformModule(
      {
        name: path,
        content,
        contentType,
      },
      {},
    );
    content = transformed.content;
    contentType =
      transformed.contentType ?? 'application/javascript; charset=utf-8';
  } else if (
    typeof content === 'string' &&
    (path.endsWith('.html') || contentType?.startsWith('text/html'))
  ) {
    content = injectConsoleBridge(content, sessionId);
  }

  return new Response(content, {headers: makeHeaders(contentType)});
};

const parseScopedUrl = (url: string) => {
  const scope = self.registration.scope;
  const sessionAndPath = url.substring(scope.length).split('?')[0];
  const slashIndex = sessionAndPath.indexOf('/');

  let sessionId: string | undefined;
  let filePath: string | undefined;
  if (slashIndex !== -1) {
    sessionId = sessionAndPath.slice(0, slashIndex);
    filePath = sessionAndPath.slice(slashIndex + 1);
  }
  return {
    sessionId,
    filePath,
  };
};

const onFetch = (e: FetchEvent) => {
  const url = e.request.url;
  try {
    if (url.startsWith(self.registration.scope)) {
      const {filePath, sessionId} = parseScopedUrl(url);
      if (sessionId !== undefined && filePath !== undefined) {
        e.respondWith(getFile(e, filePath, sessionId));
      }
    }
  } catch (err) {
    console.error(err);
  }
};

const onInstall = () => {
  void self.skipWaiting();
};

const onActivate = (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
};

const onMessage = (e: ExtendableMessageEvent) => {
  if (e.data?.type === INIT) {
    expose(workerAPI, e.data.port, {nestedProxies: true});
    e.data.port.start();
  }
};

self.addEventListener('fetch', onFetch);
self.addEventListener('activate', onActivate);
self.addEventListener('install', onInstall);
self.addEventListener('message', onMessage);
