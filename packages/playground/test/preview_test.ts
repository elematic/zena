import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {
  createLanguageService,
  createVirtualFileReader,
  lspWasmUrl,
} from '@zena-lang/language-service';
import {BareModuleTransformer} from '../lib/service-worker/bare-module-transformer.js';
import {CdnModuleRegistry} from '../lib/service-worker/cdn-module-registry.js';
import {ZenaProject} from '../lib/zena-project.js';
import STDLIB_FILES from '../src/stdlib-data.json' with {type: 'json'};

describe('BareModuleTransformer & CdnModuleRegistry', () => {
  const createTestRegistry = () =>
    new CdnModuleRegistry('https://cdn.jsdelivr.net/npm/', {
      localPackages: {
        '@zena-lang/runtime': {
          packageJson: {
            name: '@zena-lang/runtime',
            version: '0.0.1',
            type: 'module',
            exports: {'.': './index.js'},
          },
          files: {
            'index.js': {
              content: 'export const createImports = () => ({});',
              contentType: 'application/javascript; charset=utf-8',
            },
          },
        },
        '@zena-lang/wasm-web-ui': {
          packageJson: {
            name: '@zena-lang/wasm-web-ui',
            version: '0.0.1',
            type: 'module',
            exports: {'.': './index.js'},
            dependencies: {'lit-html': '^3.3.0'},
          },
          files: {
            'index.js': {
              content:
                "import {render} from 'lit-html'; export class ElementModule {}",
              contentType: 'application/javascript; charset=utf-8',
            },
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
            'index.js': {
              content: 'export const render = () => {};',
              contentType: 'application/javascript; charset=utf-8',
            },
          },
        },
      },
      fetchFn: async (input) => {
        const url = String(input);
        if (
          url ===
          'https://cdn.jsdelivr.net/npm/canvas-confetti@latest/package.json'
        ) {
          return {
            ok: true,
            status: 200,
            url: 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/package.json',
            headers: new Headers({'content-type': 'application/json'}),
            text: async () =>
              JSON.stringify({
                name: 'canvas-confetti',
                version: '1.9.3',
                module: './dist/confetti.module.mjs',
              }),
          } as Response;
        }
        if (
          url ===
          'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/package.json'
        ) {
          return {
            ok: true,
            status: 200,
            url,
            headers: new Headers({'content-type': 'application/json'}),
            text: async () =>
              JSON.stringify({
                name: 'canvas-confetti',
                version: '1.9.3',
                module: './dist/confetti.module.mjs',
              }),
          } as Response;
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

  it('rewrites bare specifiers in project JS files to ./node_modules/...', async () => {
    const registry = createTestRegistry();
    const transformer = new BareModuleTransformer(registry);

    const source = [
      "import {createImports} from '@zena-lang/runtime';",
      "import {ElementModule} from '@zena-lang/wasm-web-ui';",
      "import './other.js';",
      "import 'https://example.com/mod.js';",
    ].join('\n');

    const result = await transformer.transformModule(
      {name: 'demo.js', content: source},
      {},
    );

    assert.equal(
      result.content,
      [
        "import {createImports} from './node_modules/@zena-lang/runtime@0.0.1/index.js';",
        "import {ElementModule} from './node_modules/@zena-lang/wasm-web-ui@0.0.1/index.js';",
        "import './other.js';",
        "import 'https://example.com/mod.js';",
      ].join('\n'),
    );
  });

  it('rewrites bare specifiers inside node_modules JS files using relative paths', async () => {
    const registry = createTestRegistry();
    const transformer = new BareModuleTransformer(registry);

    const pkgJson = await registry.fetchPackageJson({
      pkg: '@zena-lang/wasm-web-ui',
      version: '0.0.1',
    });
    const cdnFile = await registry.fetch({
      pkg: '@zena-lang/wasm-web-ui',
      version: '0.0.1',
      path: 'index.js',
    });

    const result = await transformer.transformModule(
      {
        name: 'node_modules/@zena-lang/wasm-web-ui@0.0.1/index.js',
        content: cdnFile.content,
      },
      pkgJson,
    );

    assert.equal(
      result.content,
      "import {render} from '../../lit-html@3.3.0/index.js'; export class ElementModule {}",
    );
  });

  it('resolves arbitrary npm packages via CDN package.json', async () => {
    const registry = createTestRegistry();
    const transformer = new BareModuleTransformer(registry);

    const result = await transformer.transformModule(
      {
        name: 'demo.js',
        content: "import confetti from 'canvas-confetti';",
      },
      {},
    );

    assert.equal(
      result.content,
      "import confetti from './node_modules/canvas-confetti@1.9.3/dist/confetti.module.mjs';",
    );
  });
});

describe('ZenaProject preview support', () => {
  it('selects the single .html file or index.html when multiple exist', () => {
    const project = new ZenaProject();

    project.files = {'main.zena': 'export let main = () => {};'};
    assert.equal(project.getPreviewHtmlFile(), undefined);

    project.files = {
      'elements.zena': '',
      'custom.html': '<!doctype html>',
    };
    assert.equal(project.getPreviewHtmlFile(), 'custom.html');

    project.files = {
      'other.html': '<!doctype html>',
      'index.html': '<!doctype html>',
      'third.html': '<!doctype html>',
    };
    assert.equal(project.getPreviewHtmlFile(), 'index.html');
  });

  it('serves project files and compiles .zena on demand when .wasm is requested', async () => {
    const project = new ZenaProject();
    project.files = {
      'index.html': '<!doctype html><h1>Hello</h1>',
      'demo.js': 'console.log(1);',
      'elements.zena': 'export let x = 1;',
    };

    const htmlRes = await project.getFile('index.html');
    assert.ok('content' in htmlRes);
    assert.equal(htmlRes.content, '<!doctype html><h1>Hello</h1>');
    assert.equal(htmlRes.contentType, 'text/html; charset=utf-8');

    const jsRes = await project.getFile('./demo.js');
    assert.ok('content' in jsRes);
    assert.equal(jsRes.content, 'console.log(1);');
    assert.equal(jsRes.contentType, 'application/javascript; charset=utf-8');

    // Mock compileFile to verify .wasm -> .zena compilation routing
    const fakeWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    let compiledPath = '';
    project.compileFile = async (filename: string) => {
      compiledPath = filename;
      return fakeWasm;
    };

    const wasmRes = await project.getFile('elements.wasm');
    assert.equal(compiledPath, 'elements.zena');
    assert.ok('content' in wasmRes);
    assert.deepEqual(wasmRes.content, fakeWasm);
    assert.equal(wasmRes.contentType, 'application/wasm');

    const missingRes = await project.getFile('nonexistent.wasm');
    assert.ok('status' in missingRes);
    assert.equal(missingRes.status, 404);
  });

  it('dispatches reload-preview when run() is called in preview mode', () => {
    const project = new ZenaProject();
    project.preview = true;
    let reloaded = false;
    project.addEventListener('reload-preview', () => {
      reloaded = true;
    });
    project.run();
    assert.equal(reloaded, true);
  });

  it('records console logs forwarded from preview via addConsoleLog', () => {
    const project = new ZenaProject();
    let eventFired = false;
    project.addEventListener('console-changed', () => {
      eventFired = true;
    });
    project.addConsoleLog('log', 'hello from preview');
    assert.equal(eventFired, true);
    assert.equal(project.consoleLogs.length, 1);
    assert.equal(project.consoleLogs[0].level, 'log');
    assert.equal(project.consoleLogs[0].message, 'hello from preview');
  });

  it('compiles a zena:web-elements module to Wasm using bundled STDLIB_FILES', async () => {
    const wasmBytes = await readFile(fileURLToPath(lspWasmUrl));
    const service = await createLanguageService({
      wasm: wasmBytes,
      readFile: createVirtualFileReader(STDLIB_FILES),
    });

    const source = `
      import {
        ZenaElement, property, defineElement, html, css,
      } from 'zena:web-elements';

      class Counter extends ZenaElement {
        @property var count: i32 = 0;

        styles() {
          return css\`:host { display: inline-block; }\`;
        }

        render() {
          return html\`<button @click=\${(e) => { this.count += 1; }}>\${this.count}</button>\`;
        }
      }

      export let counterElement = defineElement('x-counter', () => new Counter());
    `;

    const diagnostics = service.check('elements.zena', source);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    assert.deepEqual(errors, []);

    const compiled = service.compileToWasm('elements.zena', source);
    assert.ok(compiled !== null && compiled.byteLength > 8);
    // Verify Wasm magic header \0asm
    assert.equal(compiled[0], 0x00);
    assert.equal(compiled[1], 0x61);
    assert.equal(compiled[2], 0x73);
    assert.equal(compiled[3], 0x6d);
  });
});
