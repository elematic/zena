# @zena-lang/zenadoc

Reads a Zena package's source and emits JSON describing its public API:
every module it exports, the declarations in each, their members,
signatures, types and doc comments. The consumer it exists for is the
documentation site, which renders `/reference/stdlib/` from the result
rather than from pages kept by hand.

The design, including the JSON shape and the doc comment syntax, is in
[docs/design/zenadoc.md](../../docs/design/zenadoc.md).

## Where it sits

Nothing in the language depends on this package. The dependency runs one
way — zenadoc imports the compiler, never the reverse — so the compiler,
the checker and codegen are unaffected by anything here.

Documenting a module means compiling it, and everything downstream reads
what that compile already produced. The `Compiler` parses each source
file once and its `LibraryLoader` caches the `SourceFile`; extraction
walks that same AST rather than re-reading the file; and the comments a
doc comment is built from were collected during that one parse and
travel on the `Module`, so `attachComments` only has to assign them to
nodes. There is no second parse and no second tokenize.

## Layout

| Path                        | What                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `zena/lib/doc-comment.zena` | Parses a `/**` comment into a summary, markdown description and block tags |

Tests run through the CLI's own test runner, which discovers the suites
and runs each file in its own process:

```bash
npm test -w @zena-lang/zenadoc          # via wireit
zena test "packages/zenadoc/zena/test/*_test.zena"
```
