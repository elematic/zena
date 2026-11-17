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

| Property  | Attribute  | Default                     | What it does                    |
| --------- | ---------- | --------------------------- | ------------------------------- |
| `value`   | `value`    | a hello-world program       | The initial source              |
| `theme`   | `theme`    | `one-dark`                  | CodeMirror theme                |
| `wasmUrl` | `wasm-url` | the bundled `compiler.wasm` | Where to load the compiler from |

Themes: `one-dark`, `dracula`, `github-dark`, `monokai`, `nord`,
`vscode-dark`, `solarized-dark`.

`runProgram()` compiles and runs the current source, the same as the Run
button.

## Serving the Wasm

The compiler is a ~2.1&nbsp;MB `compiler.wasm` from
[`@zena-lang/compiler`](https://www.npmjs.com/package/@zena-lang/compiler).
`wasmUrl` defaults to `new URL('./compiler.wasm', import.meta.url)`, which Vite,
webpack 5, Rollup, and Parcel resolve to an emitted asset with no extra
configuration.

**esbuild** does not rewrite that expression, so it resolves relative to the
output bundle. Either copy `compiler.wasm` next to your bundle, or set the URL:

```html
<zena-playground wasm-url="/wasm/compiler.wasm"></zena-playground>
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
- [`@zena-lang/compiler`](https://www.npmjs.com/package/@zena-lang/compiler)
  — the compiler, language service, formatter, linter, and standard library behind this.
