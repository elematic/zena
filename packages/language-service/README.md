# `language-service`

The Zena language service and Language Server Protocol (LSP) implementation: diagnostics, lint findings and quick fixes, hover, completions, go-to-definition, document symbols, and formatting.

Also published to npm as `@zena-lang/language-service` with a WebAssembly build (`lsp.wasm`) and a JavaScript/TypeScript API.

## Usage in Zena

```zena
import { createLanguageService } from 'language-service';
import { LspServer } from 'language-service/server';
import { readFile } from 'zena:fs';

async function readOrNull(path: String): Future<String | null> {
  try {
    return await readFile(path);
  } catch (e) {
    return null;
  }
}

let service = createLanguageService('/stdlib', readOrNull, 'zena-component');
let diagnostics = await service.check('/workspace/main.zena', 'export let x = 42;');
```

### Zena Libraries

- `language-service` / `language-service/service` — `LanguageService` (`createLanguageService`, `check`, `lint`, `hover`, `completions`, `definition`, `documentSymbols`)
- `language-service/server` — `LspServer` JSON-RPC request/notification handler (`LspServer`, `MessageReader`, `frame`, `offsetOf`, `positionOf`)
- `language-service/protocol` — LSP JSON serializers and error codes
- `language-service/framing` — `Content-Length` message framing (`MessageReader`, `frame`)
- `language-service/positions` — UTF-16 line/character positions to and from byte offsets (`offsetOf`, `positionOf`)
- `language-service/hover` — hover type and doc-comment formatting
- `language-service/completion` — identifier, member, and keyword completions
- `language-service/symbols` — document symbol outline (`documentSymbols`, `DocumentSymbol`, `SymbolKind`)
- `language-service/compile` — in-memory compilation to WebAssembly bytes (`compileToWasm`)
- `language-service/host` — overlay `CompilerHost` serving open documents in place of disk files (`DocumentHost`)
- `language-service/analysis` — per-document checked AST and scope analysis

## Usage in JavaScript / TypeScript (`@zena-lang/language-service`)

The WebAssembly module never touches the filesystem or the network by itself. Supply the Wasm binary and a `readFile` hook to run in Node, a browser, a Web Worker, or an editor extension host:

```ts
import {createLanguageService} from '@zena-lang/language-service';
import {readFile} from 'node:fs/promises';

const service = await createLanguageService({
  wasm: new URL('@zena-lang/language-service/lsp.wasm', import.meta.url),
  stdlibRoot: '/path/to/stdlib/zena',
  readFile: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
  },
});

for (const d of await service.check('main.zena', 'let x: i32 = "hello";')) {
  console.log(`${d.line}:${d.column} ${d.severity}: ${d.message}`);
}
```

### In a Browser

Serve the standard library from a bundled map and let `createVirtualFileReader` resolve module specifiers against it:

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

### JavaScript API

`createLanguageService(options)` returns a `ZenaLanguageService` bound to one Wasm instance:

| Method                            | Returns                           |
| --------------------------------- | --------------------------------- |
| `check(path, source?)`            | `Promise<Diagnostic[]>`           |
| `lint(path, source?)`             | `Promise<LintFinding[]>`          |
| `hover(path, offset, source?)`    | `Promise<HoverInfo \| null>`      |
| `completions(path, offset, src?)` | `Promise<CompletionItem[]>`       |
| `definition(path, offset, src?)`  | `Promise<DefinitionInfo \| null>` |
| `documentSymbols(path, source?)`  | `Promise<DocumentSymbolInfo[]>`   |
| `format(source)`                  | `string`                          |
| `compileToWasm(path, source?)`    | `Promise<Uint8Array \| null>`     |
| `openDocument(path, source)`      | shadows `readFile` for `path`     |
| `closeDocument(path)`             | drops the shadow                  |

## License

MIT
