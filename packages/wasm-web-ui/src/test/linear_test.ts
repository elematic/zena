/**
 * The linear-memory extension, against the Rust example module
 * (`examples/rust`, built by `build:rust-example`): the same host reads a
 * module that names its objects with integers and keeps its strings in
 * its own memory.
 */
import {microtasks} from './dom.js';
import {suite, test, before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {LinearMemory, TemplateHost, ElementModule, webUiImports} =
  await import('../index.js');

// Compiled test files live in packages/wasm-web-ui/test/.
const wasmUrl = new URL(
  '../examples/rust/target/wasm32-unknown-unknown/release/wasm_web_ui_example.wasm',
  import.meta.url,
);

interface CounterElement extends HTMLElement {
  count: number;
  step: number;
  label: string;
  disabled: boolean;
  readonly updateComplete: Promise<boolean>;
}

const textOf = (root: ShadowRoot): string =>
  root.innerHTML
    .replace(/<!--.*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();

suite('wasm-web-ui: a linear-memory module (Rust)', () => {
  let linear: InstanceType<typeof LinearMemory>;
  let module: WebAssembly.Module;
  let exports: WebAssembly.Exports & {
    greeting(unread: number): number;
    webui_debug_live(): number;
    webui_release(id: number): void;
  };
  let host: InstanceType<typeof TemplateHost>;
  let elements: InstanceType<typeof ElementModule>;

  before(async () => {
    const bytes = readFileSync(wasmUrl);
    // The page makes the LinearMemory first, since the imports close
    // over it, and gives it to the host it builds over the exports.
    linear = new LinearMemory();
    const result = await WebAssembly.instantiate(bytes, {
      ...webUiImports({linear}),
    });
    module = result.module;
    exports = result.instance.exports as typeof exports;
    elements = new ElementModule(exports, {linear});
    host = elements.host;
    for (const definition of elements.definitions) {
      customElements.define(definition.tag, elements.classFor(definition));
    }
  });

  test('the module imports only the protocol, and only what it calls', () => {
    const imports = WebAssembly.Module.imports(module).map(
      (i) => `${i.module}.${i.name}`,
    );
    assert.deepEqual(imports.sort(), [
      'wasm-web-ui.dispatch_event',
      'wasm-web-ui.extern_release',
      'wasm-web-ui.request_update',
    ]);
  });

  test('a module without the LinearMemory is refused', () => {
    assert.throws(() => new TemplateHost(exports), /linear-memory extension/);
  });

  test('a template-only export renders, and the strings keep their identity', () => {
    const container = document.createElement('div');
    const first = exports.greeting(3);
    host.render(first, container);
    assert.equal(
      container.innerHTML.replace(/<!--.*?-->/g, ''),
      '<p>Hello Ada, you have 3 messages.</p>',
    );
    const p = container.querySelector('p');
    const second = exports.greeting(4);
    host.render(second, container);
    assert.equal(container.querySelector('p'), p);
    assert.equal(
      host.exports.webui_result_strings(first),
      host.exports.webui_result_strings(second),
    );
  });

  test('a definition is a record, with strings decoded from the module', () => {
    const counter = elements.definitions[0]!;
    assert.equal(counter.tag, 'x-rust-counter');
    assert.equal(counter.styles, 'button { font: inherit; }');
    assert.deepEqual(
      counter.properties.map((p) => [p.name, p.kind, p.attribute]),
      [
        ['count', 2, 'count'],
        ['step', 2, 'step'],
        ['label', 1, 'label'],
        ['disabled', 3, 'disabled'],
      ],
    );
  });

  test('an element renders, reflects attributes, and updates from properties', async () => {
    const counter = document.createElement('x-rust-counter') as CounterElement;
    counter.setAttribute('count', '40');
    counter.setAttribute('step', '2');
    counter.setAttribute('label', 'Total');
    document.body.append(counter);
    assert.equal(await counter.updateComplete, true);
    assert.equal(textOf(counter.shadowRoot!), '<button>Total: 40</button>');
    assert.equal(counter.count, 40);
    assert.equal(counter.label, 'Total');
    counter.count = 5;
    counter.label = 'Sum';
    counter.disabled = true;
    await counter.updateComplete;
    assert.equal(
      textOf(counter.shadowRoot!),
      '<button disabled="">Sum: 5</button>',
    );
    assert.equal(counter.disabled, true);
    counter.remove();
    await microtasks();
  });

  test('a listener changes state, re-renders, and dispatches an event', async () => {
    const counter = document.createElement('x-rust-counter') as CounterElement;
    counter.step = 3;
    document.body.append(counter);
    await counter.updateComplete;
    let events = 0;
    counter.addEventListener('count-changed', () => {
      events += 1;
    });
    counter.shadowRoot!.querySelector('button')!.click();
    assert.equal(events, 1);
    await counter.updateComplete;
    assert.equal(counter.count, 3);
    assert.equal(textOf(counter.shadowRoot!), '<button>Count: 3</button>');
    counter.remove();
  });

  test('results are transient and instances live until released', async () => {
    const counter = document.createElement('x-rust-counter') as CounterElement;
    document.body.append(counter);
    await counter.updateComplete;
    const live = exports.webui_debug_live();
    // A render drops the previous results, and its new listener replaces
    // the part's old one, which the host releases then: the slab does
    // not grow with renders.
    counter.count = 1;
    await counter.updateComplete;
    counter.count = 2;
    await counter.updateComplete;
    assert.equal(exports.webui_debug_live(), live);
    counter.remove();

    // An instance the page drops is released when its handle is
    // collected; here the release is driven directly, as the
    // FinalizationRegistry would.
    const instance = elements.definitions[0]!.create();
    const grown = exports.webui_debug_live();
    assert.equal(grown, live + 1);
    exports.webui_release((instance.ref as {id: number}).id);
    assert.equal(exports.webui_debug_live(), live);
  });
});
