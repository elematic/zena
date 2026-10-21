import './dom.js';
import {suite, test, before} from 'node:test';
import assert from 'node:assert/strict';
import {createImports} from '@zena-lang/runtime';
import {compile} from './compile-zena.js';

const {instantiateModule} = await import('./instantiate.js');
const {TemplateHost} = await import('../index.js');
const {render} = await import('lit-html');

interface Exports extends WebAssembly.Exports {
  $stringCreate(s: string): unknown;
  greeting(name: unknown, unread: number): object;
  list(count: number): object;
  button(): object;
  clickCount(): number;
  flags(on: number): object;
  hostValue(value: unknown): object;
  nested(name: unknown): object;
}

const source = `
  import { html, TemplateResult, TemplateValue, Event, HostValue, nothing } from 'zena:web-templates';

  var clicks = 0;
  export let clickCount = (): i32 => clicks;

  export let greeting = (name: String, unread: i32): TemplateResult =>
    html\`<p class=\${name}>Hello \${name}, you have \${unread} messages.</p>\`;

  export let list = (count: i32): TemplateResult => {
    let items = new GrowableArray<TemplateValue>();
    for (var i = 0; i < count; i += 1) {
      items.push(html\`<li>\${i32ToString(i)}</li>\`);
    }
    return html\`<ul>\${items}</ul>\`;
  };

  export let button = (): TemplateResult =>
    html\`<button @click=\${(e: Event) => { clicks += 1; }}>go</button>\`;

  export let flags = (on: boolean): TemplateResult =>
    html\`<input ?disabled=\${on} .count=\${3}>\${nothing}\`;

  export let hostValue = (value: externref): TemplateResult =>
    html\`<div .data=\${new HostValue(value)}></div>\`;

  export let nested = (name: String): TemplateResult =>
    html\`<section>\${greeting(name, 1)}</section>\`;
`;

/** The text of a container with lit-html's marker comments removed. */
const textOf = (container: Element): string =>
  container.innerHTML.replace(/<!--.*?-->/g, '');

suite('wasm-web-ui: template results', () => {
  let exports: Exports;
  let module: WebAssembly.Module;
  let host: InstanceType<typeof TemplateHost>;

  before(async () => {
    const result = await instantiateModule(compile(source));
    host = new TemplateHost(result.instance.exports);
    module = result.module;
    exports = result.instance.exports as Exports;
  });

  test('a template-only module imports nothing from the protocol', () => {
    const modules = new Set(
      WebAssembly.Module.imports(module).map((i) => i.module),
    );
    assert.equal(modules.has('wasm-web-ui'), false);
    // What it imports is the Zena runtime's own: the Error stack hooks,
    // and number formatting through the host for `i32ToString`. None of
    // it reaches the DOM.
    const zena = createImports();
    for (const name of modules) {
      assert.ok(name in zena.imports, `${name} is a Zena runtime import`);
    }
    assert.deepEqual([...modules].sort(), ['env', 'zena:host:number']);
  });

  test('renders a result with text and number values', () => {
    const container = document.createElement('div');
    host.render(exports.greeting(exports.$stringCreate('Ada'), 3), container);
    assert.equal(
      textOf(container),
      '<p class="Ada">Hello Ada, you have 3 messages.</p>',
    );
  });

  test('re-rendering updates values and keeps the template', () => {
    const container = document.createElement('div');
    const first = exports.greeting(exports.$stringCreate('Ada'), 3);
    host.render(first, container);
    const p = container.querySelector('p');
    const second = exports.greeting(exports.$stringCreate('Grace'), 4);
    host.render(second, container);
    assert.equal(
      textOf(container),
      '<p class="Grace">Hello Grace, you have 4 messages.</p>',
    );
    // The same <p>: lit-html committed values into the existing DOM.
    assert.equal(container.querySelector('p'), p);
    // The strings object is the same across renders, and so is the
    // TemplateStringsArray the host built from it.
    const strings1 = host.exports.webui_result_strings(first);
    const strings2 = host.exports.webui_result_strings(second);
    assert.equal(strings1, strings2);
    assert.equal(host.strings(strings1), host.strings(strings2));
  });

  test('lists render each item and nested templates render inside', () => {
    const container = document.createElement('div');
    host.render(exports.list(3), container);
    assert.equal(textOf(container), '<ul><li>0</li><li>1</li><li>2</li></ul>');
    host.render(exports.list(1), container);
    assert.equal(textOf(container), '<ul><li>0</li></ul>');
    host.render(exports.nested(exports.$stringCreate('Lin')), container);
    assert.equal(
      textOf(container),
      '<section><p class="Lin">Hello Lin, you have 1 messages.</p></section>',
    );
  });

  test('a listener is called with the event, through one stable function', () => {
    const container = document.createElement('div');
    host.render(exports.button(), container);
    const button = container.querySelector('button')!;
    button.click();
    button.click();
    assert.equal(exports.clickCount(), 2);
    // A re-render makes a new listener object in the module; the DOM
    // listener stays the same function, and still reaches the module.
    host.render(exports.button(), container);
    button.click();
    assert.equal(exports.clickCount(), 3);
  });

  test('booleans, numbers in property position, and nothing', () => {
    const container = document.createElement('div');
    host.render(exports.flags(1), container);
    const input = container.querySelector('input')!;
    assert.equal(input.hasAttribute('disabled'), true);
    assert.equal((input as unknown as {count: unknown}).count, 3);
    host.render(exports.flags(0), container);
    assert.equal(input.hasAttribute('disabled'), false);
  });

  test('a host value comes back out unchanged', () => {
    const container = document.createElement('div');
    const payload = {answer: 42};
    host.render(exports.hostValue(payload), container);
    const div = container.querySelector('div') as unknown as {data: unknown};
    assert.equal(div.data, payload);
  });

  test('a result renders through lit-html render directly', () => {
    const container = document.createElement('div');
    render(host.result(exports.list(2)), container);
    assert.equal(textOf(container), '<ul><li>0</li><li>1</li></ul>');
  });

  test('cost of reading a 100-item list', () => {
    const container = document.createElement('div');
    host.render(exports.list(100), container);
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      host.result(exports.list(100));
    }
    const perResult = (performance.now() - start) / iterations;
    // Not asserted beyond sanity; printed for the design document.
    console.log(
      `reading a 100-item list: ${perResult.toFixed(3)} ms per result ` +
        `(${((perResult * 1000) / 100).toFixed(1)} µs per item)`,
    );
    assert.ok(perResult < 50);
  });
});
