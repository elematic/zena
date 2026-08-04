# @zena-lang/playground

An embeddable [Zena](https://github.com/elematic/zena) playground: a
`<zena-playground>` element with a CodeMirror editor, live diagnostics,
completions, hover, and a console pane — running the self-hosted Zena compiler
as WebAssembly in a Web Worker. No server, nothing to configure.

```sh
npm i @zena-lang/playground
```

```html
<script type="module">
  import '@zena-lang/playground';
</script>

<zena-playground></zena-playground>
```

That's the whole integration. It ships with the stdlib bundled, so imports like
`zena:map` resolve offline, and it compiles and runs the program in the browser
when you hit **Run** (or ⌘↵ / Ctrl+Enter).

## Attributes and properties

| Property  | Attribute | Default                | What it does                    |
| --------- | --------- | ---------------------- | ------------------------------- |
| `value`   | `value`   | a hello-world program  | The initial source              |
| `theme`   | `theme`   | `one-dark`             | CodeMirror theme                |
| `wasmUrl` | `wasmurl` | the bundled `lsp.wasm` | Where to load the compiler from |

Themes: `one-dark`, `dracula`, `github-dark`, `monokai`, `nord`,
`vscode-dark`, `solarized-dark`.

`runProgram()` compiles and runs the current source, the same as the Run
button.

## Serving the Wasm

The compiler is a ~3&nbsp;MB `lsp.wasm` from
[`@zena-lang/language-service`](https://www.npmjs.com/package/@zena-lang/language-service).
`wasmUrl` defaults to `new URL('./lsp.wasm', import.meta.url)`, which Vite,
webpack 5, Rollup, and Parcel resolve to an emitted asset with no extra
configuration.

**esbuild** does not rewrite that expression, so it resolves relative to the
output bundle. Either copy `lsp.wasm` next to your bundle, or set the URL:

```html
<zena-playground wasmurl="/wasm/lsp.wasm"></zena-playground>
```

The same goes for the worker, which the element starts with
`new URL('./worker/compiler-worker.js', import.meta.url)`. With esbuild, add
`@zena-lang/playground/worker` as a second entry point, output next to the main
bundle under `worker/`.

## Sizing

The element is `display: flex` with a default height of 600px and its own
shadow DOM, so page styles cannot leak in. Give it a size from the outside:

```css
zena-playground {
  height: 80vh;
}
```

## Related

- [`@zena-lang/codemirror`](https://www.npmjs.com/package/@zena-lang/codemirror)
  — just the CodeMirror language support, without the compiler.
- [`@zena-lang/language-service`](https://www.npmjs.com/package/@zena-lang/language-service)
  — the compiler and language service behind this, with a JavaScript API.
