# @zena-lang/codemirror

Zena language support for [CodeMirror 6](https://codemirror.net/): syntax
highlighting, a hover tooltip, and the themes the Zena playground ships with.

```sh
npm i @zena-lang/codemirror
```

## Usage

As a CodeMirror extension:

```js
import {EditorView, basicSetup} from 'codemirror';
import {zena} from '@zena-lang/codemirror';

new EditorView({
  doc: 'export let main = () => 0;\n',
  extensions: [basicSetup, zena()],
  parent: document.body,
});
```

Or declaratively, with
[`codemirror-elements`](https://www.npmjs.com/package/codemirror-elements):

```html
<cm-editor>
  <cm-lang-zena></cm-lang-zena>
  <cm-theme-one-dark></cm-theme-one-dark>
  <cm-hover-zena></cm-hover-zena>
</cm-editor>
```

## Hover tooltips

`<cm-hover-zena>` is inert until you give it a provider. It stays out of the
compiler's way on purpose — in a browser the language service runs in a Web
Worker, so answering "what is at this offset?" is asynchronous:

```js
const hover = document.querySelector('cm-hover-zena');
hover.hoverProvider = (offset) => service.hover('main.zena', offset);
```

The provider returns `{label, type, doc}` — structurally what
[`@zena-lang/language-service`](https://www.npmjs.com/package/@zena-lang/language-service)'s
`hover()` returns — or `null` for nothing to show.

Style the tooltip with the `.cm-zena-hover-tooltip`, `.cm-zena-hover-label`,
and `.cm-zena-hover-doc` classes.

## What this is not

Diagnostics, completions, and running code need the compiler. For a batteries-
included editor that wires all of that up, use
[`@zena-lang/playground`](https://www.npmjs.com/package/@zena-lang/playground).
