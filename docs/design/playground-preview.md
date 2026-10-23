# Playground Web Preview Architecture

## Status

- **Status**: Proposed
- **Date**: 2026-10-22
- **Related**: [wasm-web-ui.md](wasm-web-ui.md)

## Overview

With the addition of `@zena-lang/wasm-web-ui` and the `zena:web-elements` and
`zena:web-templates` standard library modules, users can write HTML custom
elements in Zena. To let users try Wasm Web UI in `<zena-playground>` on the
Zena website, the playground needs to support multi-file web projects (`.html`,
`.js`, `.css`, and `.zena`) rendered inside an isolated preview `<iframe>`.

Because a Zena web project loads ES modules (`demo.js`) and fetches compiled
WebAssembly binaries (`fetch('./elements.wasm')`), `srcdoc` or `blob:` URLs are
insufficient: relative URLs, ES module graphs, and `fetch()` calls require a
real URL hierarchy backed by a Service Worker that intercepts requests and
serves in-memory project files.

This document describes the preview architecture for `@zena-lang/playground` and
`@zena-lang/website`, adapted from Google's `playground-elements` and refined in
Elematic Designer.

---

## Architecture: The Players

To isolate untrusted user HTML/JS in the preview from the host documentation
site while still serving in-memory files from a Service Worker, the preview uses
two iframes and a Service Worker on a sandbox scope (which is cross-origin in
production and same-origin in local development):

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Main Window (Host Page)                          │
│                                                                            │
│  ┌──────────────────────────┐              ┌────────────────────────────┐  │
│  │      <zena-project>      │◄────────────►│      Compiler Worker       │  │
│  │  - Project files (.html, │  postMessage │  - lsp.wasm instance       │  │
│  │    .js, .css, .zena)     │              │  - check() & diagnostics   │  │
│  │  - getFile(path)         │              │  - compileToWasm(foo.zena) │  │
│  └────────────┬─────────────┘              └────────────────────────────┘  │
│               │                                                            │
│               ▼                                                            │
│  ┌──────────────────────────┐                                              │
│  │      <zena-preview>      │                                              │
│  │  - Manages session ID    │                                              │
│  │  - Exposes FileAPI via   │                                              │
│  │    Supertalk MessagePort │                                              │
│  └─────┬──────────────┬─────┘                                              │
└────────│──────────────│────────────────────────────────────────────────────┘
         │              │
         │              │ 1. CONFIGURE_PROXY / CONNECT_PROJECT_TO_SW
         │              ▼
         │     ┌─────────────────────────────────────────────────────────────┐
         │     │  Proxy Iframe (<iframe id="proxy" hidden>)                  │
         │     │  src="{sandboxBaseUrl}service-worker-proxy.html#session-id" │
         │     │  - Unsandboxed on sandboxBaseUrl origin                     │
         │     │  - Registers service-worker.js                              │
         │     │  - Bridges MessageChannel between Main Window & SW          │
         │     └─────────────────────────────┬───────────────────────────────┘
         │                                   │ 2. INIT (port2) /
         │                                   │    MISSING_FILE_API
         │ 3. Navigates to                   ▼
         │    {sandboxBaseUrl}{sessionId}/{entry.html}
         │     ┌─────────────────────────────────────────────────────────────┐
         │     │  Service Worker (service-worker.js)                         │
         │     │  Scope: {sandboxBaseUrl}                                    │
         │     │  - Maps sessionId -> Remote<FileAPI> (via Supertalk)        │
         │     │  - Intercepts fetch("{scope}{sessionId}/{filePath}")        │
         │     │  - Calls fileAPI.getFile(filePath) for project files        │
         │     │  - Serves virtual node_modules/ via CdnModuleRegistry       │
         │     │  - Rewrites bare specifiers in project & CDN .js files      │
         │     └─────────────────────────────▲───────────────────────────────┘
         ▼                                   │ 4. Intercepted fetch()
┌────────────────────────────────────────────┴───────────────────────────────┐
│  Preview Iframe (<iframe id="preview" sandbox="allow-scripts ...">)        │
│  src="{sandboxBaseUrl}{sessionId}/index.html"                              │
│  - Loads HTML, imports JS modules, fetches compiled .wasm                  │
│  - Instantiates Zena module with @zena-lang/runtime & @zena-lang/wasm-web-ui│
└────────────────────────────────────────────────────────────────────────────┘
```

### Why Two Iframes?

1. **Cross-Origin Service Worker Registration**: Service Workers are
   origin-scoped. When `sandbox-base-url` points to a separate origin in
   production (e.g., `https://sandbox.zena-lang.dev/sandbox/`), the main window
   at `https://zena-lang.dev` cannot call `navigator.serviceWorker.register()`
   for that origin. A hidden proxy iframe loaded from `sandbox-base-url` runs in
   the sandbox origin and registers the Service Worker on its behalf.
2. **Breaking the Preview Sandbox**: The preview iframe executes untrusted user
   code and is restricted by its `sandbox` attribute (`allow-scripts
allow-same-origin`). It may also reload, navigate, or crash at any time. The
   hidden proxy iframe runs only trusted bootstrap code
   (`service-worker-proxy.js`), stays alive for the lifetime of the
   `<zena-preview>` element, and carries `#session-id=<id>` in its URL hash so
   the Service Worker can locate it via `self.clients.matchAll()` even if the
   browser stops and restarts the Service Worker mid-session.

---

## Handshake & File-Serving Protocol

We adopt the protocol from Elematic Designer (`editor-frame`), which refines
`playground-elements` by replacing custom RPC state machines with `supertalk`
over `MessagePort`.

### 1. Proxy Configuration & Service Worker Registration

1. `<zena-preview>` generates a random `sessionId` and renders the hidden proxy
   iframe:
   ```html
   <iframe
     id="proxy"
     src="${sandboxBaseUrl}service-worker-proxy.html#session-id=${sessionId}"
   ></iframe>
   ```
2. On proxy iframe `load`, `<zena-preview>` creates a persistent
   `MessageChannel` (`port1`, `port2`), listens on `port1`, and posts
   `CONFIGURE_PROXY` to the proxy iframe's `contentWindow` with `port2` and
   `scope` (`new URL(sandboxBaseUrl).pathname`).
3. `service-worker-proxy.js` registers `service-worker.js` at `{scope}` and
   waits for it to reach the `activated` state (`self.skipWaiting()` and
   `self.clients.claim()`).
4. Once activated, `service-worker-proxy.js` creates a new `MessageChannel`,
   sends one port up to `<zena-preview>` via `CONNECT_PROJECT_TO_SW`, and sends
   the other port to the Service Worker via `INIT`.

### 2. Supertalk FileAPI Binding & Version Check

1. When the Service Worker receives `INIT`, it exposes its `ServiceWorkerAPI` on
   the port using `supertalk`:
   ```ts
   export interface ServiceWorkerAPI {
     setFileAPI(fileAPI: FileAPI, sessionID: string): Promise<void>;
     getHash(): Promise<string>;
   }

   export interface FileAPI {
     getFile(name: string): Promise<VirtualFile | HttpError>;
   }

   export interface VirtualFile {
     name: string;
     content: string | Uint8Array<ArrayBuffer>;
     contentType?: string;
   }

   export interface HttpError {
     status: number;
     body: string;
   }
   ```
2. `<zena-preview>` wraps its end of the port with `supertalk`'s `wrap()`,
   checks `getHash()` against the build-time `serviceWorkerHash` (sending
   `UPDATE_SERVICE_WORKER` to the proxy iframe if mismatched), and registers its
   `FileAPI` callback via `setFileAPI({ getFile }, sessionId)`.
3. Once `setFileAPI` resolves, `<zena-preview>` sets the `src` of the visible
   `<iframe id="preview">` to:
   ```
   {sandboxBaseUrl}{sessionId}/{entryHtmlFile}
   ```

### 3. Handling Service Worker Restarts (`MISSING_FILE_API`)

Browsers may terminate idle Service Workers at any time, wiping the in-memory
`fileAPIs` map. When a subsequent `fetch` event wakes the Service Worker for a
`sessionId` not in `fileAPIs`:

1. The Service Worker creates an unresolved `Promise.withResolvers<FileAPI>()`
   entry in `fileAPIs` for `sessionId`.
2. It searches `self.clients.matchAll({ includeUncontrolled: true })` for the
   proxy client whose URL hash contains `session-id=${sessionId}`.
3. It posts `{ type: MISSING_FILE_API }` to that proxy client.
4. The proxy iframe calls `connectToNewest(true)`, creating a fresh
   `MessageChannel` between `<zena-preview>` and the Service Worker.
5. `<zena-preview>` calls `setFileAPI(...)`, resolving the pending promise in
   the Service Worker and allowing the in-flight `fetch` to complete seamlessly.

---

## File Resolution, Compilation, and JS Rewriting

When the Service Worker intercepts a request for
`{scope}{sessionId}/{filePath}`, it strips query parameters and calls
`fileAPI.getFile(filePath)` on `<zena-project>`.

### 1. HTML Entry Point Selection

When `preview` is enabled on `<zena-playground>` (or `<zena-preview>`):

- If the project contains a single `.html` file (e.g., `demo.html` or
  `index.html`), `<zena-preview>` points the iframe at that file.
- If the project contains multiple `.html` files, `<zena-preview>` points the
  iframe at `index.html` (falling back to the first `.html` file if `index.html`
  is not present).
- The `.html` file content is served unmodified with `Content-Type: text/html;
charset=utf-8`.

### 2. On-Demand `.zena` → `.wasm` Compilation

When the preview iframe requests `foo.wasm` (for example via `fetch(new
URL('./elements.wasm', import.meta.url))` or
`WebAssembly.instantiateStreaming(fetch('./elements.wasm'), ...)`):

1. `ZenaProject.getFile('foo.wasm')` checks if a literal `foo.wasm` exists in
   the project.
2. If not, it maps `foo.wasm` → `foo.zena`. If `foo.zena` exists in the
   project's files:
   - It requests compilation from the compiler worker via a new `compile` worker
     message:
     ```ts
     export interface CompileRequest {
       type: 'compile';
       id: number;
       path: string;
       source: string;
       files?: Record<string, string>;
     }

     export interface CompileResponse {
       type: 'compile';
       id: number;
       wasm: Uint8Array<ArrayBuffer> | null;
       diagnostics: Diagnostic[];
     }
     ```
   - Inside `compiler-worker.ts`, `compile` syncs all `.zena` project files via
     `syncFiles(service, request.files)` and invokes
     `service.compileToWasm(request.path, request.source)`.
   - `ZenaProject` caches compiled `Uint8Array<ArrayBuffer>` outputs keyed by a
     snapshot of the project's `.zena` file contents, invalidating the cache
     whenever any `.zena` file changes.
   - If compilation succeeds, `getFile` returns:
     ```ts
     {
       name: 'foo.wasm',
       content: wasmBytes,
       contentType: 'application/wasm',
     }
     ```
   - If compilation fails, diagnostics are reported to the editor and console
     pane, and `getFile` returns an `HttpError` (`status: 500`, body with
     formatted compiler errors).

> [!NOTE] The language service (`lsp.wasm`) compiles for the `host` / `js`
> target, which is the exact target `@zena-lang/runtime` and
> `@zena-lang/wasm-web-ui` expect (`--target js`). And because the Service
> Worker responds with `Content-Type: application/wasm`, both `fetch().then(r =>
r.arrayBuffer())` and `WebAssembly.instantiateStreaming(fetch(...))` work
> inside the iframe.

### 3. JavaScript Module Resolution & Specifier Rewriting (in Service Worker)

A Zena web component project's `.js` file typically imports Zena's web runtime
packages and potentially third-party libraries:

```js
import {createImports, compileOptions} from '@zena-lang/runtime';
import {ElementModule, webUiImports} from '@zena-lang/wasm-web-ui';
```

And those packages (or any third-party npm packages imported by a demo) in turn
contain bare module specifiers of their own (e.g., `@zena-lang/wasm-web-ui`
imports `lit-html`, or `lit` imports `@lit/reactive-element` and `lit-html`).

Because CDN `.js` files also require specifier rewriting, **all JS specifier
rewriting and `node_modules/` resolution happens inside the Service Worker**,
using Elematic Designer's `BareModuleTransformer`, `NodeModuleResolver`, and
`CdnModuleRegistry` (`https://cdn.jsdelivr.net/npm/`):

1. **Project `.js` Files**:
   - When the preview iframe requests `{scope}{sessionId}/demo.js`, the Service
     Worker fetches the raw file from `fileAPI.getFile('demo.js')` (along with
     an optional project `package.json` if present, defaulting to `{}`).
   - The Service Worker runs `BareModuleTransformer.transformModule(file,
packageJson)`, which uses `es-module-lexer` to parse imports and rewrites every
     bare specifier to a canonical local path under the session's virtual
     `node_modules/`:
     ```js
     // Input:
     import {ElementModule, webUiImports} from '@zena-lang/wasm-web-ui';
     import {html} from 'lit';

     // Rewritten by BareModuleTransformer:
     import {
       ElementModule,
       webUiImports,
     } from './node_modules/@zena-lang/wasm-web-ui@0.0.1/index.js';
     import {html} from './node_modules/lit@3.3.0/index.js';
     ```
2. **Virtual `node_modules/` Requests**:
   - Because rewritten specifiers point to
     `{scope}{sessionId}/node_modules/<pkg>@<version>/<path>`, the browser's
     subsequent module fetches stay within the Service Worker's scope and are
     intercepted directly by the Service Worker (without round-tripping to the
     main window).
   - When `filePath.startsWith('node_modules/')`:
     1. The Service Worker parses `<pkg>@<version>/<subpath>` via
        `parseNpmStyleSpecifier`.
     2. It fetches the file and the package's `package.json` from the
        `ModuleRegistry`.
     3. It runs `BareModuleTransformer.transformModule(cdnFile, pkgJson)` on the
        fetched `.js` file so all transitive bare specifiers inside the package
        are also resolved against that package's `dependencies` and rewritten to
        relative `../<dep>@<resolved-version>/<entry.js>` paths under
        `node_modules/`.
3. **Canonical Resolution & Deduplication**:
   - `CdnModuleRegistry` resolves version ranges/tags (e.g., `^3.0.0` or
     `latest`) to concrete semver versions and caches resolved versions and
     fetched files across all sessions in the Service Worker.
   - `NodeModuleResolver` evaluates `package.json` `exports` (with conditions
     `['module', 'import', 'development', 'browser']`), `module`, and `main` so
     subpath exports map to exact `.js` files, guaranteeing that multiple
     packages depending on compatible ranges of `lit-html` resolve to the same
     canonical URL and share a single module instance.
4. **Built-in Local Packages (`@zena-lang/runtime`, `@zena-lang/wasm-web-ui`)**:
   - Because `@zena-lang/runtime` and `@zena-lang/wasm-web-ui` live in this
     monorepo and may not be published (or must match the exact version of the
     compiler and stdlib on the site), the Service Worker's `ModuleRegistry`
     checks a local package overlay before falling back to
     `https://cdn.jsdelivr.net/npm/`.
   - The build pipeline bundles `@zena-lang/runtime`, `@zena-lang/wasm-web-ui`,
     and `lit-html` (or their package files + `package.json`) into
     `/sandbox/vendor/`, so the Service Worker can serve and transform them
     locally with zero external network dependency while still resolving any
     other npm package from jsDelivr.

---

## Origin Isolation: Same-Origin in Dev, Separate Origin in Prod

### Local Development (`npm run serve -w @zena-lang/website`)

In local development, `sandbox-base-url` defaults to `/sandbox/` (or
`./sandbox/` relative to the playground bundle). Both the main page and the
preview iframe run on `http://localhost:8080`.

- Requires only a single dev server (`zena-run` serving `_site/`).
- `service-worker-proxy.js` logs a console warning when `parent.window` is
  accessible on a non-localhost hostname, or stays quiet on `localhost`.

### Production (`zena-lang.dev` + `sandbox.zena-lang.dev`)

In production, running the preview iframe on the same origin as `zena-lang.dev`
with `allow-same-origin` (which Service Workers require) would allow scripts in
the preview iframe to access `zena-lang.dev`'s origin storage and parent window.
To isolate the preview:

1. **Same Container, Separate Origin**: The static assets for the sandbox
   (`/sandbox/service-worker-proxy.html`, `/sandbox/service-worker-proxy.js`,
   `/sandbox/service-worker.js`, and `/sandbox/vendor/*`) are built directly
   into `_site/sandbox/` by Eleventy / esbuild. In Cloud Run, a second domain
   mapping (e.g., `sandbox.zena-lang.dev`) or a dedicated Cloud Run service URL
   points to the **same** `zena-website` container image.
2. **Headers on `server.zena` (`packages/website/zena/server.zena`)**:
   - `Origin-Agent-Cluster: ?1` on responses (and in the Service Worker's
     synthesized `Response` headers), allowing the browser to allocate a
     separate process/agent cluster for `sandbox.zena-lang.dev` even though it
     is same-site with `zena-lang.dev`.
   - `Access-Control-Allow-Origin: *` on `/sandbox/*` assets so fonts, vendor
     modules, and sourcemaps load cleanly across origins.
3. **Configuring `sandbox-base-url`**:
   - `<zena-playground>` and `<zena-preview>` accept a `sandbox-base-url`
     attribute/property (defaulting to a relative `./sandbox/` URL).
   - On the production website build (`NODE_ENV=production` / site config), the
     website passes `sandbox-base-url="https://sandbox.zena-lang.dev/sandbox/"`
     (falling back to `/sandbox/` when unset or in local dev).

---

## Playground Component Changes (`@zena-lang/playground`)

### 1. `<zena-preview>` Component

A new `<zena-preview>` element extending `PlaygroundConnectedElement`:

- **Properties / Attributes**:
  - `project`: connected `<zena-project>` ID or instance.
  - `sandboxBaseUrl` (`sandbox-base-url`): base URL of the service worker
    sandbox directory.
  - `htmlFile` (`html-file`): optional explicit HTML filename override; defaults
    to auto-detecting the single `.html` file or `index.html`.
- **Behavior**:
  - Manages the hidden `#proxy` iframe and visible `#preview` iframe
    (`sandbox="allow-scripts allow-same-origin allow-forms"`).
  - Establishes the `supertalk` connection to the Service Worker and registers
    `getFile` delegated to `this.projectElement.getFile(path)`.
  - Automatically loads the preview once the Service Worker and compiler worker
    are ready.
  - Listens for a `reload-preview` event from `<zena-project>` (triggered when
    the user clicks **Run** / **Reload** or presses `Cmd/Ctrl+Enter`) and
    reloads the preview iframe (`iframe.src = iframe.src`).

### 2. `<zena-output>` & `<zena-playground>` Layout

When `preview` is enabled on `<zena-playground preview>` (or `<zena-output
preview>`):

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│ index.html │ demo.js │ elements.zena│ [Preview] [Console (0)]   ● Ready ↻ │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│  CodeMirror Editor                  │   <zena-preview>                    │
│  (HTML / JS / CSS / Zena)           │   (Sandboxed Iframe)                │
│                                     │   ┌─────────────────────────────┐   │
│                                     │   │ <x-counter>                 │   │
│                                     │   │ [ Count: 10 ]               │   │
│                                     │   └─────────────────────────────┘   │
│                                     │                                     │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

- **Tabbed Output Pane**: When `preview` is set, `<zena-output>` displays a view
  switcher in its header between **Preview** (active by default) and **Console**
  (showing a badge if errors or new console logs arrive), keeping both panes
  mounted so switching tabs does not reset the iframe or lose logs.
- **Run / Reload Action**:
  - On initial load, once `lsp.wasm` and the Service Worker are ready, the
    preview loads automatically.
  - Clicking **Run** (or pressing `Cmd/Ctrl+Enter`) runs a typecheck and
    triggers a preview iframe reload.
  - If `<zena-project>` is in `preview` mode and there is no `main()` export in
    the `.zena` files, `ZenaProject.run()` reloads the preview instead of
    logging `"Compiled, but there is nothing to run — export a main"`.

### 3. Multi-Language Support in `<zena-project>` & `<zena-file-editor>`

Currently, `<zena-project>` and `<zena-file-editor>` assume every file in the
project is a `.zena` file. For web projects:

- **`<zena-project>`**:
  - Recognizes `<script type="sample/html">`, `<script type="sample/js">`,
    `<script type="sample/css">`, and `<script type="sample/zena">` in
    `#parseScriptsFromDom()`.
  - Filters non-`.zena` files out of `service.check()` entry selection:
    `getZenaFiles()` returns only `.zena` files, checking each `.zena` file (or
    the entry `.zena` file) so `index.html` and `demo.js` are never passed to
    the Zena parser.
  - Allows deleting or renaming any file when `editableFileSystem` is true, not
    hardcoding `main.zena` as undeletable when a project uses `elements.zena`.
- **`<zena-file-editor>`**:
  - Detects the active file's extension (`.zena`, `.html`, `.js`/`.mjs`, `.css`,
    `.json`).
  - Attaches `<cm-lang-zena>`, `<cm-hover-zena>`, Zena autocompletion, and lint
    diagnostics **only** when the active file is a `.zena` file.
  - Uses `@codemirror/lang-html`, `@codemirror/lang-javascript`, and
    `@codemirror/lang-css` language extensions when editing `.html`, `.js`, and
    `.css` files.

### 4. `<zena-example-playground>` Integration (`@zena-lang/website-client`)

In `packages/website-client/src/zena-example-playground.ts`:

- Each `<figure>` in `playground-examples.njk` (or docs pages) can carry a
  `preview` attribute:
  ```html
  <figure id="example-web-components" category="Web UI" preview>
    <figcaption>Web Components</figcaption>
    <script type="sample/zena" filename="elements.zena">
      ...
    </script>
    <script type="sample/js" filename="demo.js">
      ...
    </script>
    <script type="sample/html" filename="index.html">
      ...
    </script>
  </figure>
  ```
- When an example with `preview` is selected, `<zena-example-playground>` sets
  `playground.preview = true` on `<zena-playground>`; when switching back to a
  console-only example, it sets `playground.preview = false`.

---

## Build & Bundling Pipeline

### `@zena-lang/playground`

1. Adds `supertalk` and `es-module-lexer` (plus `@codemirror/lang-html`,
   `@codemirror/lang-javascript`, `@codemirror/lang-css`) to dependencies.
2. Adds new modules in `packages/playground/src/`:
   - `src/zena-preview.ts` (`<zena-preview>`)
   - `src/preview-shared/service-worker-api.ts`
   - `src/preview-shared/proxy-api.ts`
   - `src/preview-shared/versions.ts`
   - `src/service-worker/service-worker-proxy.ts`
   - `src/service-worker/service-worker.ts`
   - `src/service-worker/bare-module-transformer.ts`
   - `src/service-worker/cdn-module-registry.ts`
   - `src/service-worker/node-module-resolver.ts`
3. Exports `./service-worker` and `./service-worker-proxy` in
   `packages/playground/package.json`.

### `@zena-lang/website`

In `packages/website/eleventy.config.js`:

1. Adds esbuild entry points for the sandbox into `_site/sandbox/`:
   - `sandbox/service-worker.js` (from `@zena-lang/playground/service-worker`,
     bundled as ESM)
   - `sandbox/service-worker-proxy.js` (from
     `@zena-lang/playground/service-worker-proxy`, bundled as ESM)
   - `sandbox/vendor/zena-runtime.js` (from `@zena-lang/runtime`)
   - `sandbox/vendor/wasm-web-ui.js` (from `@zena-lang/wasm-web-ui`)
   - `sandbox/vendor/lit-html.js` (from `lit-html`)
2. Emits `_site/sandbox/service-worker-proxy.html`, which loads
   `./service-worker-proxy.js`.
3. Adds `../wasm-web-ui:build` and `../runtime:build` to
   `packages/website/package.json` Wireit dependencies for `build`.
