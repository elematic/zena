# @zena-lang/zenadoc

Reads a Zena package's source and emits JSON describing its public API:
every module it exports, the declarations in each, their members,
signatures, types and doc comments.

```bash
zena doc packages/stdlib -o stdlib.json   # a package
zena doc ./src                            # any directory, to stdout
zena doc main.zena                        # a single file
```

The design, including the JSON shape and the doc comment syntax, is in
[docs/design/zenadoc.md](../../docs/design/zenadoc.md).

## Who uses it

Nothing in the language depends on this package. The dependency runs one
way — zenadoc imports the compiler, never the reverse — so the compiler,
the checker and codegen are unaffected by anything here.

| Consumer                | How                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `zena doc` (`zena-cli`) | Compiles and runs `zena/cli/main.zena`, the same way `bench` and `test` run their orchestrators |
| `@zena-lang/website`    | Its build runs `zena doc` over the stdlib and renders `/reference/stdlib/` from the result      |

The language server does not use it yet, and should: `lsp.zena` carries
its own `isDocComment` / `extractDocComment`, which predate this package
and do less — they drop blank lines, so a doc comment's paragraphs and
fenced code run together in hover, and they do not read block tags at
all. Moving hover onto `lib/doc-comment.zena` would fix both and give
hover `@param` and `@returns`.

## Parsing happens once

Documenting a module means compiling it, and everything downstream reads
what that compile already produced:

- The **`Compiler`** parses each source file once and its `LibraryLoader`
  caches the `SourceFile`, so the standard library is parsed once per
  compiler no matter how many modules of a package are being documented.
- **Extraction walks that same AST.** `extractModule` takes the
  `Module` the compile produced; it never re-reads or re-parses a file.
- **Comment attachment reuses the tokenizer's output.** The comments a
  doc comment is built from were collected during that one parse and
  travel on the `Module`; `attachComments` only assigns them to nodes.
- **Checking is threaded.** `checkCompilation` carries the previous
  `ProgramCheckResult` across a batch's entry points, so a file whose
  source has not changed — the whole standard library, after the first
  entry — keeps its `CheckResult` instead of being checked again.

Entry points are compiled in batches of 16 through one compiler each,
following the portable-test runner: a compiler accumulates per-entry
state that is never collected, so one compiler for a whole package ends
up slower than several. See `packages/zena-compiler/CONTEXT.md`.

Re-exports cost nothing extra to parse. A facade like `zena:map` is
parsed once and the implementation files it re-exports from are parsed
once, the same as any other import — the loader does not care that the
importer re-exports what it imports.

They do need a second _walk_, which is the step that turns an AST into
the model. `zena:map` declares nothing of its own, so its page is built
by walking the private files it re-exports from. `WalkCache` holds every
file walked so far in the run, keyed by canonical path, and a module's
own walk goes in as soon as it is documented — so a file is walked once,
and only a file that is documented as a module _after_ a facade already
pulled it in is walked twice. Across the standard library that is 16
walks beyond the 46 module pages, for about 30 private files.

## Layout

| Path                        | What                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `zena/lib/doc-comment.zena` | Parses a `/**` comment into a summary, markdown description and block tags |
| `zena/lib/model.zena`       | The API model, and the anchors that make it addressable                    |
| `zena/lib/type-text.zena`   | Renders a type annotation back to source text                              |
| `zena/lib/extract.zena`     | Walks one module's AST into the model                                      |
| `zena/lib/package.zena`     | Finds a package's modules, from a manifest or from the filesystem          |
| `zena/lib/reexports.zena`   | Follows a re-export to what it carries                                     |
| `zena/lib/document.zena`    | Compiles and documents a whole package                                     |
| `zena/lib/json.zena`        | Serializes the model                                                       |
| `zena/cli/main.zena`        | The command line `zena doc` runs                                           |

Tests run through the CLI's own test runner, which discovers the suites
and runs each file in its own process:

```bash
npm test -w @zena-lang/zenadoc          # via wireit
zena test "packages/zenadoc/zena/test/*_test.zena"
```
