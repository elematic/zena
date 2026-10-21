/**
 * Loads the demo module and registers its elements. Serve the repository
 * root (for example `python3 -m http.server` from the repo root) and open
 * packages/wasm-web-ui/demo/index.html; build the module first with
 * `npm run build:demo -w @zena-lang/wasm-web-ui`.
 */
import {createImports, compileOptions} from '@zena-lang/runtime';
import {ElementModule, webUiImports} from '@zena-lang/wasm-web-ui';

const info = document.querySelector('#info');
const bytes = await fetch(new URL('./elements.wasm', import.meta.url)).then(
  (r) => r.arrayBuffer(),
);

// The module is instantiated like any other. Its import object merges
// two libraries': the Zena runtime's, which a module written in Zena
// asks of its embedder (the Error stack hooks, Unicode case mapping,
// `console`; none of them reach this page), and the protocol's
// (`request_update`, `dispatch_event` and the granted capabilities; pass
// `webUiImports({capabilities: []})` to grant no event access). The
// compile options turn on the JS String Builtins the module's strings
// use.
const zena = createImports();
const {module, instance} = await WebAssembly.instantiate(
  bytes,
  {...zena.imports, ...webUiImports()},
  compileOptions,
);
zena.attach(instance.exports);

// The module exports its element definitions as records: a tag,
// properties, styles and a constructor. `ElementModule` reads them once
// through the module's exports and defines nothing on this page: where
// the browser has scoped custom element registries, the tagged
// definitions go into a registry of the module's own, so its elements
// can use each other; otherwise they are only handed back.
const elements = new ElementModule(instance.exports);

// Registration is the page's act. `classFor` derives an `HTMLElement`
// class from a record, and this page defines each one under the tag the
// module suggests because its own markup uses them; a page could define
// them under other names, or in a scoped registry of its own. The badge
// was declared without a tag (`declareElement` in elements.zena), so the
// page names it.
const tags = [];
for (const definition of elements.definitions) {
  if (definition.tag !== '') {
    customElements.define(definition.tag, elements.classFor(definition));
    tags.push(definition.tag);
  }
}
const badge = elements.definitions.find((d) => d.tag === '');
customElements.define('page-badge', elements.classFor(badge));

const imports = WebAssembly.Module.imports(module).map(
  (i) => `${i.module}.${i.name}`,
);
info.textContent =
  `${bytes.byteLength} bytes\n` +
  `module's own registry: ${elements.registry === null ? 'none (no scoped registries here)' : 'scoped'}\n` +
  `defined by this page: ${tags.join(', ')}, page-badge\n` +
  `imports: ${imports.join(', ') || 'none'}`;

// The element is a normal custom element: properties set from
// JavaScript reach the module through its typed setter exports, and the
// module asks for a render.
document.querySelector('#bump').addEventListener('click', () => {
  document.querySelector('x-counter').count = 100;
});
