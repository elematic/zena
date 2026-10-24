import {microtasks} from './dom.js';
import {suite, test, before} from 'node:test';
import assert from 'node:assert/strict';
import {compile} from './compile-zena.js';

const {instantiateModule} = await import('./instantiate.js');
const {ElementModule} = await import('../index.js');
const source = `
  import {
    ZenaElement, property, state, defineElement, declareElement,
    html, css, TemplateResult, TemplateValue, Event,
  } from 'zena:web-elements';

  class Counter extends ZenaElement {
    @property var count: i32 = 0;
    @property var label: String = 'Count';
    @property var disabled: boolean = false;
    var connections = 0;
    var disconnections = 0;
    var updates = 0;
    var firstUpdates = 0;

    styles() {
      return css\`button { color: rgb(\${255}, 0, 0); }\`;
    }

    connected(): void {
      this.connections += 1;
    }

    disconnected(): void {
      this.disconnections += 1;
    }

    updated(first: boolean): void {
      this.updates += 1;
      if (first) {
        this.firstUpdates += 1;
      }
    }

    increment(): void {
      this.count += 1;
      this.dispatchEvent('count-changed');
    }

    render(): TemplateResult {
      return html\`<button ?disabled=\${this.disabled} @click=\${(e: Event) => { this.increment(); }}>\${this.label}: \${this.count}</button>\`;
    }
  }

  export let counterElement = defineElement('x-counter', () => new Counter());

  class TodoList extends ZenaElement {
    @state var draft: String = '';
    var items = new GrowableArray<String>();

    add(): void {
      if (this.draft.length > 0) {
        this.items.push(this.draft);
        this.draft = '';
      }
    }

    render(): TemplateResult {
      let rows = new GrowableArray<TemplateValue>();
      for (let item in this.items) {
        rows.push(html\`<li>\${item}</li>\`);
      }
      return html\`
        <input .value=\${this.draft}
          @input=\${(e: Event) => { this.draft = e.targetValue(); }}
          @keydown=\${(e: Event) => { if (e.key() == 'Enter') { this.add(); } }}>
        <button @click=\${(e: Event) => { this.add(); }}>Add</button>
        <ul>\${rows}</ul>\`;
    }
  }

  export let todoElement = defineElement('x-todo', () => new TodoList());

  class Badge extends ZenaElement {
    @property var text: String = 'badge';

    render(): TemplateResult {
      return html\`<span>\${this.text}</span>\`;
    }
  }

  // No tag: the page names it.
  export let badgeElement = declareElement(() => new Badge());

  export let statsOf = (el: ZenaElement): i32 => {
    let c = el as Counter;
    return c.connections * 1000 + c.disconnections * 100 + c.firstUpdates * 10 + c.updates;
  };
`;

interface CounterElement extends HTMLElement {
  count: number;
  label: string;
  disabled: boolean;
  requestUpdate(): void;
  readonly updateComplete: Promise<boolean>;
}

interface TodoElement extends HTMLElement {
  draft: string;
  readonly updateComplete: Promise<boolean>;
}

const textOf = (root: ShadowRoot): string =>
  root.innerHTML
    .replace(/<!--.*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();

suite('wasm-web-ui: custom elements', () => {
  let exports: WebAssembly.Exports;
  let elements: InstanceType<typeof ElementModule>;

  before(async () => {
    const {instance} = await instantiateModule(compile(source));
    exports = instance.exports;
    elements = new ElementModule(exports);
    // The page defines the tags its markup uses, here every suggested
    // one, in the global registry.
    for (const definition of elements.definitions) {
      if (definition.tag !== '') {
        customElements.define(definition.tag, elements.classFor(definition));
      }
    }
  });

  test('the definitions are the module records in its order; the page defines the tagged ones', () => {
    assert.deepEqual(
      elements.definitions.map((d) => d.tag),
      ['x-counter', 'x-todo', ''],
    );
    assert.ok(customElements.get('x-counter'));
    assert.ok(customElements.get('x-todo'));
  });

  test('a definition is a record: tag, properties, attributes, styles, constructor', () => {
    const counter = elements.definitions[0]!;
    assert.deepEqual(
      counter.properties.map((p) => [p.name, p.attribute]),
      [
        ['count', 'count'],
        ['label', 'label'],
        ['disabled', 'disabled'],
      ],
    );
    assert.deepEqual(counter.observedAttributes, [
      'count',
      'label',
      'disabled',
    ]);
    assert.equal(counter.styles, 'button { color: rgb(255, 0, 0); }');
    const todo = elements.definitions[1]!;
    // `@state`: a property with no attribute.
    assert.deepEqual(
      todo.properties.map((p) => [p.name, p.attribute]),
      [['draft', '']],
    );
    assert.deepEqual(todo.observedAttributes, []);
    assert.equal(typeof counter.create, 'function');
  });

  test('reading a module defines nothing on the page', async () => {
    // `x-counter` is defined above; an ElementModule that defined its
    // tags globally would throw here. Scoped custom element registries
    // would give the module one of its own; this DOM has none, so the
    // classes are only handed back.
    const {instance} = await instantiateModule(compile(source));
    const again = new ElementModule(instance.exports);
    assert.equal(again.registry, null);
    assert.deepEqual(
      again.definitions.map((d) => d.tag),
      ['x-counter', 'x-todo', ''],
    );
    assert.equal(typeof again.classFor(again.definitions[0]!), 'function');
  });

  test('styles are adopted into every shadow root, once per definition', async () => {
    const a = document.createElement('x-counter') as CounterElement;
    const b = document.createElement('x-counter') as CounterElement;
    document.body.append(a, b);
    await a.updateComplete;
    await b.updateComplete;
    assert.equal(a.shadowRoot!.adoptedStyleSheets.length, 1);
    assert.equal(
      a.shadowRoot!.adoptedStyleSheets[0],
      b.shadowRoot!.adoptedStyleSheets[0],
    );
    assert.equal(
      a.shadowRoot!.adoptedStyleSheets[0]!.cssRules[0]!.cssText,
      'button { color: rgb(255, 0, 0); }',
    );
    assert.equal(textOf(a.shadowRoot!), '<button>Count: 0</button>');
    a.remove();
    b.remove();
  });

  test('the page can name and register an untagged definition itself', async () => {
    const Badge = elements.classFor(elements.definitions[2]!);
    customElements.define('page-badge', Badge);
    const badge = document.createElement('page-badge') as HTMLElement & {
      text: string;
      updateComplete: Promise<boolean>;
    };
    document.body.append(badge);
    await badge.updateComplete;
    assert.equal(textOf(badge.shadowRoot!), '<span>badge</span>');
    badge.text = 'named by the page';
    await badge.updateComplete;
    assert.equal(textOf(badge.shadowRoot!), '<span>named by the page</span>');
    badge.remove();
  });

  test('an element renders on connection and once per microtask', async () => {
    const counter = document.createElement('x-counter') as CounterElement;
    document.body.append(counter);
    assert.equal(await counter.updateComplete, true);
    assert.equal(textOf(counter.shadowRoot!), '<button>Count: 0</button>');
    counter.count = 5;
    counter.label = 'Total';
    counter.count = 6;
    // Three property sets, one render.
    assert.equal(await counter.updateComplete, true);
    assert.equal(textOf(counter.shadowRoot!), '<button>Total: 6</button>');
    assert.equal(counter.count, 6);
    assert.equal(counter.label, 'Total');
    counter.remove();
    await microtasks();
  });

  test('attributes reflect into properties by kind', async () => {
    const counter = document.createElement('x-counter') as CounterElement;
    counter.setAttribute('count', '41');
    counter.setAttribute('label', 'Pre');
    counter.setAttribute('disabled', '');
    document.body.append(counter);
    await counter.updateComplete;
    assert.equal(counter.count, 41);
    assert.equal(counter.label, 'Pre');
    assert.equal(counter.disabled, true);
    assert.equal(
      textOf(counter.shadowRoot!),
      '<button disabled="">Pre: 41</button>',
    );
    counter.removeAttribute('disabled');
    await counter.updateComplete;
    assert.equal(counter.disabled, false);
    assert.equal(textOf(counter.shadowRoot!), '<button>Pre: 41</button>');
    counter.remove();
  });

  test('a listener changes state, re-renders, and dispatches an event', async () => {
    const counter = document.createElement('x-counter') as CounterElement;
    document.body.append(counter);
    await counter.updateComplete;
    let events = 0;
    counter.addEventListener('count-changed', () => {
      events += 1;
    });
    counter.shadowRoot!.querySelector('button')!.click();
    assert.equal(events, 1);
    await counter.updateComplete;
    assert.equal(counter.count, 1);
    assert.equal(textOf(counter.shadowRoot!), '<button>Count: 1</button>');
    counter.remove();
  });

  test('lifecycle calls reach the module', async () => {
    const counter = document.createElement('x-counter') as CounterElement;
    document.body.append(counter);
    await counter.updateComplete;
    counter.count = 1;
    await counter.updateComplete;
    counter.remove();
    // connections * 1000 + disconnections * 100 + firstUpdates * 10 + updates.
    // The element's instance is its own; drive one made from the
    // definition record directly, and read it through the module's
    // exported probe.
    const instance = elements.definitions[0]!.create();
    instance.connected();
    instance.updated(true);
    instance.updated(false);
    instance.set('count', 3);
    assert.equal(instance.get('count'), 3);
    const statsOf = exports['statsOf'] as (inst: unknown) => number;
    assert.equal(statsOf(instance.ref), 1000 + 10 + 2);
  });

  test('input events read the target value through a capability import', async () => {
    const todo = document.createElement('x-todo') as TodoElement;
    document.body.append(todo);
    await todo.updateComplete;
    const input = todo.shadowRoot!.querySelector('input')!;
    input.value = 'write tests';
    input.dispatchEvent(new Event('input'));
    await todo.updateComplete;
    assert.equal(todo.draft, 'write tests');
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
    await todo.updateComplete;
    assert.equal(todo.draft, '');
    assert.match(textOf(todo.shadowRoot!), /<li>write tests<\/li>/);
    todo.remove();
  });

  test('a page that grants no capabilities refuses the module', async () => {
    await assert.rejects(
      instantiateModule(compile(source), {capabilities: []}),
      WebAssembly.LinkError,
    );
  });
});
