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
| `src/compile.zena`    | Compiling a document to a module, for the playground              |
| `src/server.zena`     | `LspServer`: the protocol's requests and notifications            |
| `src/protocol.zena`   | The protocol's JSON, and its error codes                          |
| `src/positions.zena`  | Protocol positions (UTF-16) to and from byte offsets              |
| `src/framing.zena`    | `Content-Length` framing of messages                              |
| `src/lsp.zena`        | Flat Wasm exports compiled into `lsp.wasm`                        |
| `ts/index.ts`         | TypeScript/JavaScript wrapper around `lsp.wasm`                   |
| `ts/test/`            | Node.js integration tests for `lsp.wasm` and the JS API           |
| `test/`               | Zena unit and LSP protocol tests                                  |

## Building and Testing

`lsp.wasm` is built from `src/lsp.zena` by the Zena compiler, and `index.js` is built from `ts/index.ts` by `tsc`:

```bash
npm run build -w @zena-lang/language-service
npm test -w @zena-lang/language-service
```

To run only the Zena tests:

```bash
npm run test:zena -w @zena-lang/language-service
```
