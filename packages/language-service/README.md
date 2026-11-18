# `language-service`

The Zena language service and Language Server Protocol (LSP) library: diagnostics, lint findings and quick fixes, hover, completions, go-to-definition, document symbols, and formatting.

Used by `zena lsp` (in `packages/zena-cli`) and compiled to WebAssembly by `@zena-lang/compiler` (`packages/compiler-js`) for JavaScript, browser, and VS Code hosts.

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

## License

MIT
