# Zenadoc: API documentation extraction

Zena has no way to publish the API of a library. The website's
`/reference/stdlib/` pages are all placeholders, and every one of them
would have to be hand-written and hand-maintained against a standard
library that changes every week. Zenadoc is the tool that reads a
package's source and emits a JSON description of its public API, which
the Eleventy site (and any other consumer) renders.

The name refers to three things that this document keeps distinct:

- **doc comments** — `/** … */` comments attached to declarations in
  Zena source.
- **the extractor** — a Zena library, `packages/zenadoc`, that turns a
  compiled package into an API model.
- **`zena doc`** — the CLI subcommand that runs the extractor over a
  package, folder, or file and writes JSON.

## Scope

Zenadoc describes what a package exposes: its modules, the
declarations each module exports, the members of those declarations,
their types, and their doc comments. It does not render HTML, generate
markdown, or decide navigation — those are the site's job, and keeping
them out means other consumers (an LSP-adjacent tool, a
`zena doc --check` coverage gate, an agent reading a package it has
never seen) get the same data.

Not in scope for the first version: cross-package linking beyond
recording the target's canonical id, doc comments on statements inside
function bodies, and inherited-member flattening (the model records the
supertype; a consumer that wants a flattened member list can compute
one from the ids).

### Re-exports

A module that re-exports is documented as carrying what it re-exports.
`zena:map` declares nothing and re-exports `Map`, `MapEntry` and
`HashMap` from files that are private to the standard library, so
recording the specifier and stopping there would document `zena:map` as
an empty page — and the declarations appear nowhere else, because their
files are private. Each re-export is followed to the file it names,
that file is walked, and the declarations it carries are copied in
under the names the re-exporting module exports them as. Each copy
records the canonical id of the module that declares it, so a consumer
can say where it comes from and link there when that module is
documented too.

## Input: what a package is

Zenadoc takes one path and produces one JSON document.

**A directory with a package manifest** is the intended input. The
manifest is `zena-package.json` as described in
[package-manifest.md](package-manifest.md): its `exports` map names the
modules the package makes importable, and each module names an entry
file. That map is exactly the module list to document — files not in it
are package-private, so their declarations are not part of the public
API even when marked `export`.

**A directory without a manifest** is an open package: every `.zena`
file under the root is a module, with the module id derived from the
path relative to the root. This is the mode a small project or a
scratch directory gets for free.

**A single file** is a package of one module. Useful for testing the
extractor and for documenting an example.

The package name comes from `--name`, else the manifest's
`name` field, else the directory's basename. Module ids are
`<package>:<module>` — the string a user would write in an `import`.

A manifest may name a source root, which is what lets the standard
library keep its manifest at `packages/stdlib/stdlib-manifest.json`
while its sources sit under `packages/stdlib/zena`. Entry files are
relative to that root.

A virtual module has one entry file per compilation target, and exists
only on the targets it names. Documentation is per target: `zena doc
--target zena-cli` documents `zena:console` as the WASI entry file and
leaves out `zena:component-async` entirely, because a `zena-cli`
program cannot import it and documenting it would describe an API that
is not there.

### The standard library

The stdlib is a package whose manifest is spelled differently: it lives
at `packages/stdlib/stdlib-manifest.json` and its module map is called
`modules` rather than `exports`. Rather than special-case the stdlib in
zenadoc's code, zenadoc reads `zena-package.json` if present and
`stdlib-manifest.json` otherwise, and accepts either key. Adding
`"name": "zena"` to the stdlib manifest then gives the stdlib the same
treatment as any other package, and `zena:array` ids fall out of the
normal `<package>:<module>` rule.

The rename of `stdlib-manifest.json` to `zena-package.json` is planned
independently (see package-manifest.md); zenadoc reading both means the
rename does not have to happen first. Note that the compiler does not
read this file at all — `zena/lib/stdlib-manifest.zena` carries a baked
copy of the same list, and the two must be kept in sync. Zenadoc reads
the JSON, so a module missing from the JSON is missing from the docs
even if it compiles.

## The extractor

`packages/zenadoc` is a Zena package registered in
`zena-packages.json` as `zenadoc`, importing the compiler the same way
`zena-formatter` and `language-service` do. Its inputs are things the
compiler already produces:

- **The AST** (`Module` and the declaration nodes) for syntax that has
  no semantic counterpart: modifiers, whether a return type was written
  or inferred, source order, source locations.
- **The `SemanticModel`** for resolved types, so an unannotated
  declaration documents the type it actually has and a type reference
  can name the declaration it resolves to.
- **`attachComments`** (`zena-compiler:comment-attachment`), which
  already assigns each comment to the nearest node. The formatter and
  the language server both use it; zenadoc filters its leading comments
  for `/** … */`.

Documenting a package means compiling it. Zenadoc drives one
`Compiler`, calling `compile()` once per exported module — the entry
path for a stdlib module is its id (`zena:array`), which the compiler
already supports — then `checkCompilation` over the result, then walks
each module's AST with its `SemanticModel`. Two constraints from the
existing test runners carry over: cap entry points per compiler at 16
(a compiler accumulates per-entry state that is never collected, so one
compiler for a whole package gets slower than several — measurements in
`packages/zena-compiler/CONTEXT.md`), and never let one source file be
loaded under two module ids, which produces two same-named nominal
types that compare unequal.

Type errors do not stop extraction. Diagnostics go to stderr and the
process exits non-zero, but the JSON is still written: a package that
does not check is exactly when someone wants to read its docs.

## Doc comments

A doc comment is a block comment whose opening is `/**`, attached as a
leading comment to a declaration. `//` and `///` line comments are not
doc comments — this matches what the language server already does for
hover, and one rule for both avoids a declaration whose hover and
published docs disagree.

The comment body is markdown after each line's leading `*` and one
space are stripped. Lines beginning with `@` at the top level of the
comment start a block tag; everything before the first tag is the
description, and the first paragraph of the description is the summary
(what a module index shows next to each name).

Recognized tags:

| Tag                    | Meaning                                        |
| ---------------------- | ---------------------------------------------- |
| `@param name text`     | Describes one parameter                        |
| `@returns text`        | Describes the return value                     |
| `@throws Type text`    | An error this can throw                        |
| `@example title?`      | Following fenced code block is an example      |
| `@deprecated text?`    | Marks the declaration deprecated               |
| `@see target`          | A related declaration, module id, or URL       |
| `@since version`       | Version the declaration appeared in            |

Unrecognized tags are preserved verbatim rather than dropped, so a
package can carry its own conventions and a consumer can render or
ignore them. Zenadoc does not check that `@param` names match the
parameters — that belongs in a later `zena doc --check` mode, alongside
undocumented-export reporting.

## Output: the JSON model

One JSON document per package. Version-tagged, so a consumer can refuse
a format it does not understand:

```json
{
  "zenadoc": 1,
  "package": {"name": "zena", "version": null, "root": "packages/stdlib/zena"},
  "modules": [ … ]
}
```

A module:

```json
{
  "id": "zena:array",
  "name": "array",
  "file": "array.zena",
  "doc": { … } | null,
  "declarations": [ … ]
}
```

A declaration carries a `kind` — `function`, `variable`, `class`,
`interface`, `mixin`, `enum`, `typeAlias`, or `symbol` — plus:

```json
{
  "kind": "class",
  "name": "GrowableArray",
  "id": "zena:array#GrowableArray",
  "anchor": "growablearray",
  "signature": "final class GrowableArray<T> implements Iterable<T>",
  "modifiers": ["final"],
  "typeParameters": [{"name": "T", "bound": null, "default": null}],
  "extends": {"text": "…", "links": […]} | null,
  "implements": [ … ],
  "mixins": [ … ],
  "variants": [ … ],
  "members": [ … ],
  "doc": { … } | null,
  "loc": {"file": "array.zena", "line": 12, "column": 1}
}
```

`id` is the canonical cross-reference key: module id, `#`, then the
dotted path within the module (`zena:array#GrowableArray.push`).
`anchor` is the same thing reduced to a URL fragment, deduplicated
within its module. A member records `kind` (`field`, `method`,
`getter`, `setter`, `constructor`, `operator`), `static`, mutability
for fields, its parameters, and its type.

### Type references

Every type in the model is a text rendering plus the spans within that
text that name a declaration:

```json
{
  "text": "Map<String, Array<T>>",
  "links": [
    {"start": 0, "end": 3, "id": "zena:collections#Map"},
    {"start": 4, "end": 10, "id": "zena:string#String"},
    {"start": 12, "end": 17, "id": "zena:array#Array"}
  ]
}
```

The alternative — emitting a structured type tree and letting each
consumer render it — moves Zena's type syntax into every consumer, and
they would disagree. The alternative in the other direction, a bare
string, throws away the resolution the checker already did and leaves
the website regex-matching type names, which is wrong for a type
parameter named `T` in a package that also exports a class `T`. Text
plus spans keeps rendering in one place and keeps the links exact.

Spans come from `typeToString`, extended to record where it wrote each
nominal type's name, and from the nominal types' `symbolId`, which
identifies the declaring module and name.

### Ordering and stability

Declarations and members appear in source order. Nothing in the output
depends on hash iteration order, absolute paths, or the time of the
run: the same source produces the same bytes, so the output can be
checked in, diffed in review, and used as a snapshot test. Paths are
package-root-relative for the same reason.

## `zena doc`

```
zena doc <path> [-o out.json] [--name <package>] [-t <target>]
              [--include-private]
```

`<path>` is a package directory, any directory, or a `.zena` file.
Output goes to stdout when `-o` is absent, so it pipes.

`--include-private` documents non-exported declarations and `#private`
members; the default is the public API only. The flag exists for
reading a codebase you are working on, not for publishing.

The subcommand follows `zena bench` and `zena test`: the Rust CLI is
thin, and the work happens in a Zena program that the CLI compiles and
runs. That program works from the repository root, like the other
Zena-side tools, so an input path inside the checkout is passed
repo-relative — which is what makes the `root` and `file` paths in the
JSON repo-relative, so the output can be checked in. An output path is
made absolute instead, because it is relative to wherever the command
was run.

## Website consumption

The Eleventy site gains a data file that reads the generated JSON and a
pagination template that emits one page per module, replacing the
placeholder pages under `/reference/stdlib/`. The site build depends on
the extractor through Wireit, so the pages cannot go stale relative to
the stdlib source.

Generated pages and hand-written prose have to coexist: the API listing
for `zena:array` is generated, but the page's introduction and examples
are worth writing by hand. The design is that a hand-written markdown
file for a module, when one exists, provides the page's prose and the
generated model provides the API listing below it.

## Implementation stages

Each stage is a PR that stacks on the previous one.

1. **Doc comment parsing.** The `DocComment` model (summary,
   description, tags), the parser from a raw comment body, unit tests.
   No compiler involvement — this stage is pure text.
2. **Declaration extraction.** AST + `SemanticModel` to the API model
   for one module, the JSON emitter, and a golden-file test over a
   fixture package.
3. **Packages.** Manifest reading, module enumeration, multi-module
   compilation, `stdlib-manifest.json` compatibility, and a `"name"`
   field for the stdlib manifest. At the end of this stage the stdlib's
   JSON is generated in full.
4. **Type reference spans.** `typeToString` records nominal-type spans;
   the model carries links. Split out because it touches the compiler
   and the stages before it are useful with text-only types.
5. **`zena doc`.** The Rust subcommand.
6. **Website.** Data file, templates, styling, and the stdlib reference
   pages switched over.
