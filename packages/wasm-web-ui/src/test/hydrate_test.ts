/**
 * Hydration: an element that arrives with a shadow root the server
 * rendered (`renderElement` on the `zena-cli` target, through
 * `ssr/render.zena`) attaches lit-html's parts to that markup on its
 * first update instead of rendering, and updates in place afterwards.
 *
 * happy-dom does not parse declarative shadow DOM, so the test gives
 * the element its shadow root the way the parser would: attached and
 * filled before the element upgrades.
 */
import './dom.js';
import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile} from './compile-zena.js';
import {renderWithZena} from './ssr-render.js';

const {instantiateModule} = await import('./instantiate.js');
const {ElementModule} = await import('../index.js');

const elementsUrl = new URL('../src/test/ssr/elements.zena', import.meta.url);

interface CounterElement extends HTMLElement {
  count: number;
  readonly updateComplete: Promise<boolean>;
}

suite('wasm-web-ui: hydration', () => {
  test('server-rendered markup is hydrated, not replaced, and then updates in place', async () => {
    const markup = renderWithZena().at(-1)!;
    assert.match(
      markup,
      /^<x-counter count="7"><template shadowroot="open" shadowrootmode="open">/,
    );
    const inner = markup.slice(
      markup.indexOf('>', markup.indexOf('<template')) + 1,
      markup.lastIndexOf('</template>'),
    );

    // The element before its class exists: attributes and shadow root as
    // the parser would leave them.
    const host = document.createElement('x-counter');
    host.setAttribute('count', '7');
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = inner;
    document.body.append(host);
    const style = root.querySelector('style');
    assert.ok(style, 'the server wrote the styles');
    const button = root.querySelector('button');
    assert.ok(button, 'the server wrote the template');

    const source = readFileSync(elementsUrl, 'utf8');
    const {instance} = await instantiateModule(compile(source));
    const elements = new ElementModule(instance.exports);
    for (const definition of elements.definitions) {
      customElements.define(definition.tag, elements.classFor(definition));
    }
    // A browser replays an upgraded element's attributes into
    // attributeChangedCallback; happy-dom does not, so set it again
    // before the first update runs, which is what the parser's upgrade
    // would have given the instance.
    host.setAttribute('count', '7');
    const counter = host as CounterElement;
    assert.equal(await counter.updateComplete, true);

    // Hydrated: the nodes the server wrote are the ones still there.
    assert.equal(root.querySelector('style'), style);
    assert.equal(root.querySelector('button'), button);
    assert.equal(root.adoptedStyleSheets.length, 0, 'no second stylesheet');
    assert.equal(counter.count, 7);
    assert.match(button.textContent ?? '', /Count: 7/);

    // Alive: a property set and a listener both update the hydrated DOM.
    counter.count = 8;
    await counter.updateComplete;
    assert.match(button.textContent ?? '', /Count: 8/);
    button.click();
    await counter.updateComplete;
    assert.equal(counter.count, 9);
    assert.match(button.textContent ?? '', /Count: 9/);
    host.remove();
  });
});
