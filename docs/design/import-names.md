# How imports name packages

An import names a library of another package. This document decides how
a specifier writes the package's scope, its name and the library, what
an import with no library means, and how a workspace package's name
follows from its scope. [package-manifest.md](package-manifest.md)
defines local names and the manifest, and
[package-manager.md](package-manager.md#names-and-scopes) defines scopes
and handles.

> **Current status**: implemented: the compiler reads both forms of name,
> `zena pkg add` writes `<scope>:<name>`, `scopedNames` turns that off,
> and this repository's imports use the form, wit-parser's in the scope
> `zena-lang`.

## The form

```zena
import {Lexer} from 'zena-lang:wit-parser/lexer';     // a package in a scope
import {parse} from 'zena-lang:wit-parser';           // its main library
import {route} from 'acme:router';                    // another package's
import {Router} from 'router/server';                 // a package without a scope
import {HashMap} from 'zena:map';                     // the standard library
import {now} from 'wasi:clocks/system-clock';         // a WIT interface
```

A specifier is `[<scope>:]<package>[/<library>]`:

- **`<scope>:`** names the scope the package is in. It ends at the `:`,
  and every `/` comes after it, so the `:` is always the outer separator.
- **`<package>`** ends at the first `/`.
- **`/<library>`** is the library's path from the package's `source`
  directory, without `.zena`, and may hold more `/`s. Without it, the
  import names the package's main library (below).

A package without a scope is one added with `--name`, one with a handle
on its own domain, or a workspace package with no scope.

The grammar, where a label is a DNS label as package and scope names are:

```
specifier = relative | [ label ":" ] label [ "/" library ]
library   = segment { "/" segment }
```

A relative specifier starts with `./` or `../` and names a file, so
`router/server` never reads as a path.

**The standard library is the scope `zena`.** Each of its libraries reads
as a package of that scope, with an index and libraries under it
(`zena:core`, `zena:url`, `zena:collections/hash-map`), and the compiler
resolves `zena:` against the standard library it carries, as now. No
import of the standard library changes.

**A WIT dependency names a scope.** WIT writes its interfaces as
`<namespace>:<package>/<interface>`, which is this form, so a
`{"wit": ...}` dependency's key is a WIT namespace (`wasi`, `gfx`), and
everything after its `:` is the package and interface the WIT declares.

## The main library

An import of a package's name alone, `'acme:router'`, imports its main
library: the library its manifest's `main` names, or `main`, the
library `main.zena`, when it names none. A `main` must be one of the
package's `exports` when it lists them.

```json
{"name": "router", "main": "server", "exports": {"server": {}, "match": {}}}
```

`main` is the name an application's entry point already has, so a
package reads the same whether it is run or imported: its front door is
`main.zena`. A package that is both, a tool with a library, can keep
its `main()` in `main.zena` and point `main` at the library, so that
importers do not load the tool.

There is no default library for a directory. Since a library is named
without `.zena`, `router/middleware` can be `middleware.zena` beside a
`middleware/` directory, and a directory needs no `index.zena` to be
importable by its name. An `exports` entry with a `path` can still name
any file.

## Names are still local

`<package>` and `<scope>:<package>` are both local names: what the
importing package's manifest calls the dependency, a key of its
`dependencies`. The manifest maps the name to a DID, so an import never
holds a domain or a handle, and a rename or a move to another App View
changes nothing in source. Two packages may still give one dependency
two names, or one name to two packages.

The name `zena pkg add` gives a dependency, when it is not told one, is:

- **`<scope>:<name>`** when the package's handle is in a scope: on the
  default App View, `<name>.<scope>.<domain>`, or `<name>.<domain>`
  where the workspace's `scopes` maps `<scope>` to `<domain>`. So
  `zena pkg add zena-lang:wit-parser` and
  `zena pkg add wit-parser.zena-lang.pkg.zena-lang.dev` both write
  `"zena-lang:wit-parser"`.
- **The name the package's profile suggests**, for a handle on the
  package's own domain, such as `json.example.com`, and for every package
  when the workspace root's manifest says `"scopedNames": false`.

`--name` gives any other name of either form. With scoped names, the
names packages give one dependency agree, and every import says where
its package came from. A workspace that prefers short names turns them
off once, and its imports read `router/server`.

## Workspace packages

A workspace package with a `scope` in its manifest, its own or the
workspace root's, is `<scope>:<name>` in its workspace; one without a
scope is `<name>`. Its own libraries and tests can also import it by its
plain `name`, unless one of its dependencies has that name, and
`zena pkg add` refuses to give a dependency that name. A package that
depends on it by path calls it by the dependency's key, which can be
either name, as for any dependency: with `"markdown": {"path":
"../markdown"}`, `import {parse} from 'markdown'` imports
`zena-lang:markdown`. The workspace's files that belong to no package
see the packages by their names, and by the keys of the root manifest's
dependencies.

So giving a package a scope renames nothing in its workspace. Its
published dependents import it as `<scope>:<name>`, the name
`zena pkg add` gives it, which is what its README's examples show.

In this repository, the packages the Zena project publishes have
`"scope": "zena-lang"`. The compiler imports `packages/wit-parser` as
`zena-lang:wit-parser` and the registry imports `packages/markdown` as
`markdown`; the root manifest names `workflow` and `zebra` for the
libraries of the `zena` command, which are in no package.

## The `zena-lang` scope

Packages the Zena project publishes are in the `zena-lang` scope:
`zena-lang:wit-parser`, handle `wit-parser.zena-lang.pkg.zena-lang.dev`.
`zena` is the standard library's and no App View scope's. The App View
reserves both, and its operator creates `zena-lang`.

## Where the names are shown

- **The site** shows a package as `<scope>:<name>`, with its handle and
  DID beside it, and the command that adds it.
- **The CLI** takes `<scope>:<name>`, a handle or a DID, and prints the
  name it wrote. `scopes` maps scope names, without `@`, to domains.
- **Errors and documentation** use the name the import uses.

## What it takes

- The resolver reads scopes, packages without one, imports with no
  library, and WIT namespaces as scopes. The manifest's `dependencies`
  take keys of both forms.
- A workspace package's name comes from its `name` and its `scope`.
- `zena pkg add` takes and writes `<scope>:<name>`, unless
  `scopedNames` is false; `--name` takes either form.
- `packages/wit-parser` gets its scope, and its importers are renamed.
- The App View reserves `zena-lang`, and the site shows `<scope>:<name>`.
- package-manifest.md, the language reference and the website's
  reference describe the forms.

## Alternatives considered

**`@<scope>/<package>:<library>`**, as npm writes scopes. It keeps the
standard library one package (`zena:map`), apart from first-party
packages (`@zena/wit-parser`). But a library path brings `/`s to both
sides of the `:`, and in `@zena/wit-parser:wit/lexer` the `:` reads as
part of a segment, not as the separator that matters most. It is also a
third spelling beside WIT's and the handle's.

**Handles in imports** (`'wit-parser.zena-lang.pkg.zena-lang.dev/wit'`).
They are exact, but long, and a rename or a move to another App View
would change every import.

**Plain local names only**, as before (`wit-parser:wit`). An import then
says nothing about where the package came from, and two packages named
`router` in different scopes need `--name` to tell them apart. A
workspace keeps this with `scopedNames`.

**The `zena` scope for the Zena project's packages too.** A library could
then move from the standard library into a published package without
its imports changing. But `zena:` would no longer mean "built in, with
no version", and every standard library name would reserve a package
name.
