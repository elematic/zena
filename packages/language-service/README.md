# @zena-lang/language-service

The Zena language service and compiler, compiled to WebAssembly, with a
JavaScript API around it.

One package holds both `lsp.wasm` and the wrapper that calls into it, so the
two can't drift: the getters the API reads are the getters that build exported.

```sh
npm i @zena-lang/language-service
```

## Usage

The module never touches the filesystem or the network by itself. You supply
the Wasm and a `readFile` hook, so the same code runs in Node, in a browser,
in a Web Worker, and in an editor extension host.

```ts
import {createLanguageService} from '@zena-lang/language-service';
import {readFileSync} from 'node:fs';

const service = await createLanguageService({
  wasm: new URL('@zena-lang/language-service/lsp.wasm', import.meta.url),
  stdlibRoot: '/path/to/stdlib/zena',
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
});

for (const d of service.check('main.zena', 'let x: i32 = "hello";')) {
  console.log(`${d.line}:${d.column} ${d.severity}: ${d.message}`);
}
```

`wasm` accepts a URL, a string, a `Response`, bytes, or an already-compiled
`WebAssembly.Module`. It defaults to `lspWasmUrl`, which resolves `lsp.wasm`
relative to this module — bundlers that understand
`new URL(..., import.meta.url)` emit it as an asset automatically.

### In a browser

There is no filesystem, so serve the stdlib from a bundled map and let
`createVirtualFileReader` resolve module specifiers against it:

```ts
import {
  createLanguageService,
  createVirtualFileReader,
} from '@zena-lang/language-service';
import stdlib from './stdlib-data.json' with {type: 'json'};

const service = await createLanguageService({
  readFile: createVirtualFileReader(stdlib),
});
```

Every method is synchronous, and a full check is slow enough to drop frames.
Run it in a Web Worker — or use
[`@zena-lang/playground`](https://www.npmjs.com/package/@zena-lang/playground),
which already does.

## API

`createLanguageService(options)` returns a `ZenaLanguageService` bound to one
Wasm instance:

| Method                            | Returns                       |
| --------------------------------- | ----------------------------- |
| `check(path, source?)`            | `Diagnostic[]`                |
| `hover(path, offset, source?)`    | `HoverInfo \| null`           |
| `completions(path, offset, src?)` | `CompletionItem[]`            |
| `definition(path, offset, src?)`  | `DefinitionInfo \| null`      |
| `documentSymbols(path, source?)`  | `DocumentSymbolInfo[]`        |
| `format(source)`                  | `string`                      |
| `compileToWasm(path, source?)`    | `Uint8Array \| null`          |
| `openDocument(path, source)`      | shadows `readFile` for `path` |
| `closeDocument(path)`             | drops the shadow              |

Analysis is stateful: `check()` parses and types a document, and the position
queries read back from that analysis. Passing `source` to a query checks first,
so a query for a document that was never checked still works.

`service.exports` is the raw Wasm exports, for anything not wrapped here.

## Building

`lsp.wasm` is built from `zena/lsp.zena` by the Zena compiler:

```sh
npm run build -w @zena-lang/language-service
```
