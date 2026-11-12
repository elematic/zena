# Development

Notes for working on `zenadoc`.

## Architecture

Nothing in the language depends on `zenadoc`. The dependency runs one way — `zenadoc` imports `zena-compiler`, never the reverse — so the compiler, type checker, and code generator are unaffected by changes here.

Documenting a module means compiling it, and everything downstream reads what that compile already produced:

- The **`Compiler`** parses each source file once and its `LibraryLoader` caches the `SourceFile`, so the standard library is parsed once per compiler no matter how many modules of a package are being documented.
- **Extraction walks that same AST.** `extractModule` takes the `Module` the compile produced; it never re-reads or re-parses a file.
- **Comment attachment reuses the tokenizer's output.** The comments a doc comment is built from were collected during that one parse and travel on the `Module`; `attachComments` only assigns them to nodes.
- **Checking is threaded.** `checkCompilation` carries the previous `ProgramCheckResult` across a batch's entry points, so a file whose source has not changed keeps its `CheckResult` instead of being checked again.

Entry points are compiled in batches of 16 through one compiler each, following the portable-test runner: a compiler accumulates per-entry state that is never collected, so one compiler for a whole package ends up slower than several.

`WalkCache` holds every file walked so far in the run, keyed by canonical path, so private implementation files re-exported through a facade module are walked at most once unless also documented as standalone modules.

## Layout

| Path                 | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `src/model.zena`     | The API model, and the anchors that make it addressable                        |
| `src/ids.zena`       | Naming a file inside a package                                                 |
| `src/type-text.zena` | Renders a type annotation to text, recording the spans that name a declaration |
| `src/links.zena`     | Resolves a type reference to the declaration it names, through scope analysis  |
| `src/publish.zena`   | Which page hosts a declaration, and rewriting links to it                      |
| `src/inherit.zena`   | Copies members a declaration inherits from its supertypes                      |
| `src/extract.zena`   | Walks one module's AST into the model                                          |
| `src/package.zena`   | Finds a package's modules, from a manifest or from the filesystem              |
| `src/reexports.zena` | Follows a re-export to what it carries                                         |
| `src/document.zena`  | Compiles and documents a whole package                                         |
| `src/json.zena`      | Serializes the model                                                           |
| `dev/main.zena`      | Standalone command-line runner                                                 |
| `test/`              | Unit and fixture tests                                                         |

## Running Tests

```bash
npm test -w @zena-lang/zenadoc
```

Or run the test suite directly:

```bash
./target/release/zena-cli test "packages/zenadoc/test/*_test.zena"
```
