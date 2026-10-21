/**
 * Drives the demo module (demo/elements.wasm) under happy-dom the way
 * demo/index.html does, and prints what each element renders. Run it
 * from the repository root after `npm run build:demo -w
 * @zena-lang/wasm-web-ui` and `npm test -w @zena-lang/wasm-web-ui`
 * (the DOM shim it imports is built with the tests):
 *
 *     node packages/wasm-web-ui/probe/demo-drive.js
 */
import {readFileSync} from 'node:fs';

await import('../test/dom.js');
const {createImports, compileOptions} = await import('@zena-lang/runtime');
const {ElementModule, webUiImports} = await import('../index.js');
const bytes = readFileSync(new URL('../demo/elements.wasm', import.meta.url));
const zena = createImports();
const {module, instance} = await WebAssembly.instantiate(
  bytes,
  {...zena.imports, ...webUiImports()},
  compileOptions,
);
zena.attach(instance.exports);
const elements = new ElementModule(instance.exports);
const tags = [];
for (const definition of elements.definitions) {
  if (definition.tag !== '') {
    customElements.define(definition.tag, elements.classFor(definition));
    tags.push(definition.tag);
  }
}
customElements.define(
  'page-badge',
  elements.classFor(elements.definitions.find((d) => d.tag === '')),
);
console.log('tags:', tags.join(', '), '| module registry:', elements.registry);
console.log(
  'imports:',
  WebAssembly.Module.imports(module)
    .map((i) => `${i.module}.${i.name}`)
    .join(', '),
);

const microtasks = () => new Promise((resolve) => setTimeout(resolve, 0));
const textOf = (el) =>
  el.shadowRoot.innerHTML
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<!--.*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();

document.body.innerHTML = `
  <x-counter count="10" step="5"></x-counter>
  <x-counter disabled></x-counter>
  <x-todo title="Things to do"></x-todo>
  <page-badge text="named here"></page-badge>
  <page-badge></page-badge>`;
await microtasks();
const [c1, c2] = document.querySelectorAll('x-counter');
const todo = document.querySelector('x-todo');
const [b1, b2] = document.querySelectorAll('page-badge');

console.log('counter 1:', textOf(c1), '| count', c1.count, 'step', c1.step);
console.log('counter 2:', textOf(c2), '| disabled', c2.disabled);
c1.shadowRoot.querySelector('button').click();
await microtasks();
console.log('counter 1 after click:', textOf(c1), '| count', c1.count);
c1.count = 100;
await microtasks();
console.log('counter 1 after count = 100:', textOf(c1));

console.log('todo:', textOf(todo), '| title', todo.title);
const input = todo.shadowRoot.querySelector('input[type=text]');
input.value = 'write the docs';
input.dispatchEvent(new Event('input'));
await microtasks();
console.log('todo draft:', JSON.stringify(todo.draft));
input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
await microtasks();
console.log(
  'todo after Enter:',
  textOf(todo),
  '| draft',
  JSON.stringify(todo.draft),
);
todo.shadowRoot
  .querySelector('input[type=checkbox]')
  .dispatchEvent(new Event('change'));
await microtasks();
console.log('todo after toggle:', textOf(todo));

console.log('badge 1:', textOf(b1), '| badge 2:', textOf(b2));
