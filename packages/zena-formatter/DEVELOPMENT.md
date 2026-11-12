# Development

Notes for working on `zena-formatter`.

## Layout

- `src/doc.zena` — Prettier-style document intermediate representation (`Doc`) and builder functions
- `src/doc-printer.zena` — line-breaking algorithm (`printDocToString`, `fits`, `propagateBreaks`)
- `src/printer.zena` — Zena AST and comment printer (`format`)
- `test/` — unit tests for the document printer, Zena formatter output, operator precedence agreement, and AST preservation

## Running Tests

```bash
npm test -w @zena-lang/zena-formatter
```

Or run a single test file directly:

```bash
./target/release/zena-cli test packages/zena-formatter/test/formatter_test.zena
```
