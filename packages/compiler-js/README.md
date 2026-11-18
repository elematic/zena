# `@zena-lang/compiler`

The [Zena](https://zena-lang.dev) compiler, language service, formatter, linter, and standard library packaged as a WebAssembly-GC module (`compiler.wasm`) with individual `stdlib/` `.zena` files and an asynchronous JavaScript/TypeScript API.

## Installation

```sh
npm install @zena-lang/compiler @zena-lang/runtime
```

## Usage

### Node.js or Static HTTP Hosts

`createCompiler()` loads `compiler.wasm` and reads standard library modules asynchronously on demand from `./stdlib/` (from disk in Node.js via `node:fs/promises`, or via `fetch()` when served over HTTP):

```ts
import {createCompiler} from '@zena-lang/compiler';
import {instantiate, run} from '@zena-lang/runtime';

const compiler = await createCompiler();

const source = `
  import { GrowableArray } from 'zena:core';
  export let main = () => {
    let items = new GrowableArray<i32>();
    items.push(42);
    console.log(\`\${items[0]}\`);
  };
`;

const diagnostics = await compiler.check('main.zena', source);
if (!diagnostics.some((d) => d.severity === 'error')) {
  const wasm = await compiler.compileToWasm('main.zena', source);
  if (wasm) {
    const {instance} = await instantiate(wasm);
    await run(instance);
  }
}
```

Pass `readFile` to resolve project-local imports alongside the standard library:

```ts
import {readFile} from 'node:fs/promises';
import {createCompiler} from '@zena-lang/compiler';

const compiler = await createCompiler({
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
});
```

### Bundled Browser Workers

For single-file browser workers without static `stdlib/` file serving, bundle a `Record<string, string>` map and pass `createVirtualFileReader`:

```ts
import {createCompiler, createVirtualFileReader} from '@zena-lang/compiler';

const compiler = await createCompiler({
  wasm: '/assets/compiler.wasm',
  readFile: createVirtualFileReader(stdlibMap),
});
```

## Package Exports

| Export path                         | Description                                                                                                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zena-lang/compiler`               | Compiler & language service API (`createCompiler`, `ZenaCompiler`, `createVirtualFileReader`, `compilerWasmUrl`, `stdlibUrl`, plus `createLanguageService` / `ZenaLanguageService` / `lspWasmUrl` aliases) |
| `@zena-lang/compiler/compiler.wasm` | Direct asset path to the `-O2` `compiler.wasm` binary                                                                                                                                                      |
| `@zena-lang/compiler/stdlib/*`      | Individual Zena standard library `.zena` and `.wit` source files                                                                                                                                           |

## API Overview

`await createCompiler(options)` returns a `ZenaCompiler` instance bound to one Wasm module:

| Method                                  | Return type                                |
| --------------------------------------- | ------------------------------------------ |
| `check(path, source?)`                  | `Promise<Diagnostic[]>`                    |
| `compileToWasm(path, source?, target?)` | `Promise<Uint8Array<ArrayBuffer> \| null>` |
| `lint(path, source?)`                   | `Promise<LintFinding[]>`                   |
| `format(source)`                        | `string`                                   |
| `hover(path, offset, source?)`          | `Promise<HoverInfo \| null>`               |
| `completions(path, offset, source?)`    | `Promise<CompletionItem[]>`                |
| `definition(path, offset, source?)`     | `Promise<DefinitionInfo \| null>`          |
| `documentSymbols(path, source?)`        | `Promise<DocumentSymbolInfo[]>`            |
| `openDocument(path, source)`            | `void`                                     |
| `closeDocument(path)`                   | `void`                                     |

## License

MIT
