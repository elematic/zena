# `@zena-lang/compiler`

The [Zena](https://zena-lang.dev) compiler, language service, formatter, linter, and standard library packaged as a WebAssembly-GC module (`compiler.wasm`) with a host-agnostic JavaScript/TypeScript API.

## Installation

```sh
npm install @zena-lang/compiler @zena-lang/runtime
```

## Usage

### In a Browser or Web Worker (bundled standard library)

Import `stdlibFiles` from `@zena-lang/compiler/stdlib` and pass `createVirtualFileReader(stdlibFiles)` as `readFile`:

```ts
import {createCompiler, createVirtualFileReader} from '@zena-lang/compiler';
import {stdlibFiles} from '@zena-lang/compiler/stdlib';
import {instantiate, run} from '@zena-lang/runtime';

const compiler = await createCompiler({
  readFile: createVirtualFileReader(stdlibFiles),
});

const source = `
  export let main = () => {
    console.log('Hello from Zena!');
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

### In Node.js (filesystem imports + bundled stdlib)

```ts
import {readFile} from 'node:fs/promises';
import {createCompiler, createVirtualFileReader} from '@zena-lang/compiler';
import {stdlibFiles} from '@zena-lang/compiler/stdlib';

const readStdlib = createVirtualFileReader(stdlibFiles);

const compiler = await createCompiler({
  wasm: await readFile(
    new URL('@zena-lang/compiler/compiler.wasm', import.meta.url),
  ),
  readFile: async (path) => {
    const stdlibSource = readStdlib(path);
    if (stdlibSource !== undefined) return stdlibSource;
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
});
```

## Subpath Exports

| Import specifier                    | Description                                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zena-lang/compiler`               | Compiler & language service API (`createCompiler`, `ZenaCompiler`, `createVirtualFileReader`, `compilerWasmUrl`, plus `createLanguageService` / `ZenaLanguageService` / `lspWasmUrl` aliases) |
| `@zena-lang/compiler/stdlib`        | Prebuilt in-memory map (`Record<string, string>`) of Zena's standard library `.zena` sources                                                                                                  |
| `@zena-lang/compiler/compiler.wasm` | Direct asset path to the compiled `compiler.wasm` binary                                                                                                                                      |

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
