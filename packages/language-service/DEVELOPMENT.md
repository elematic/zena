# Development

Notes for working on `language-service`.

## Layout

| Path                  | Purpose                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `src/service.zena`    | `LanguageService`: the compiler, open documents, go to definition |
| `src/host.zena`       | The compiler host that serves open documents in place of files    |
| `src/analysis.zena`   | What the features share about a checked file                      |
| `src/hover.zena`      | Hover                                                             |
| `src/completion.zena` | Completions                                                       |
| `src/symbols.zena`    | Document symbols, the outline                                     |
| `src/compile.zena`    | Compiling a document to a module, for browser/JS hosts            |
| `src/server.zena`     | `LspServer`: the protocol's requests and notifications            |
| `src/protocol.zena`   | The protocol's JSON, and its error codes                          |
| `src/positions.zena`  | Protocol positions (UTF-16) to and from byte offsets              |
| `src/framing.zena`    | `Content-Length` framing of messages                              |
| `src/lsp.zena`        | Flat Wasm exports compiled into `packages/compiler/compiler.wasm` |
| `test/`               | Zena unit and LSP protocol tests                                  |

## Testing

```bash
npm test -w @zena-lang/language-service
```

JavaScript/WebAssembly wrapper tests live in `packages/compiler` (`npm test -w @zena-lang/compiler`).
