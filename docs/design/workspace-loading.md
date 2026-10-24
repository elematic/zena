# Loading a Workspace's Manifests

How the compiler reads a workspace's `zena-package.json` manifests, why
it reads all of them for every compile, and what reading only the ones a
compile reaches would take. The manifest format and the resolution rules
are in [package-manifest.md](package-manifest.md); this document changes
neither, except where it says so. It is the design for
[#535](https://github.com/elematic/zena/issues/535).

> **Status**: proposed, not scheduled. The build no longer depends on it
> (see "The build graph today").

## Overview

`loadWorkspace` (`zena-compiler/zena/lib/package-manifest.zena`) runs
before a compile resolves anything. It reads the root manifest, every
`workspace.packages` entry's manifest, the manifests of their path
dependencies, and the pins in `zena-lock.json` with each pinned package's
manifest from the package cache. The result is a map from package key to
`PackageConfig`, and `ModuleResolver` answers every import from that map
without doing I/O.

A compile's output depends only on the manifests of the packages it
reaches, but it reads all of them, so:

- A manifest that cannot be read (malformed JSON, two packages with one
  name, a path dependency with no manifest) fails every compile in the
  workspace, including compiles that never reach that package.
- The compile cache (`compileCached` in `zena-cli/zena/compile.zena`)
  records every manifest in a module's `.deps`, so an edit to any
  manifest invalidates every cached module. `zena add` and `zena update`
  edit a manifest and the lockfile each time they run.
- Nothing can check a wireit script's declared manifests against what
  its compiles read, since every compile reads everything.

## The build graph today

Each wireit script lists the root manifest and the manifests of the
packages its compiles reach (`AGENTS.md`, "Declaring inputs"). That is
sound only while every manifest can be read, which the root
`check:workspace` script tests: it compiles a file that imports nothing,
with the zena command and with the checked-in bootstrap. The lists are
kept by hand, beside the source globs they follow.

Lazy loading would not change which scripts rerun. It would make
`check:workspace` a check of the workspace as a whole and no longer a
condition for the narrow lists, and it would let a test compare each
script's manifests with a compile's `.deps`.

## A lazy loader

### A resolver that can ask for a package

`ModuleResolver` finds a file's package by iterating every package root
(`findPackageForPath`) and finds a dependency by the importing package's
`dependencies`, whose values are package keys. A key is a package's
`name`, from its manifest. So the resolver needs a loader it can ask:

- `packageOf(path)`: the package whose root holds `path`. The roots of
  workspace packages come from the root manifest's `workspace.packages`
  without reading their manifests (a `dir/*` entry needs a directory
  listing). The manifest of the package found is read then, once.
- `dependency(package, name)`: the key `name` stands for in `package`,
  reading the target's manifest the first time.

`PackageConfig` stays as it is, and a test can give the resolver a loader
over an in-memory map, as tests give it a map today.

### Files outside any package

A file that is in no package sees every workspace package by its name.
The name is in each package's manifest, so the first such import has to
read every workspace manifest. Today these import workspace packages by
name:

| directory                                                        | imports                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/zena-cli/zena` (the CLI module)                        | zena-compiler, zb, zenadoc, zena-formatter, zena-lint, atproto, package-manager, language-service |
| `packages/zena-cli/dev/bundle.zena`                              | workflow                                                                                          |
| `packages/zena-cli/tests/fixtures`                               | atproto, package-manager, pds                                                                     |
| `packages/language-service/zena` (`lsp.zena`, tests)             | zena-compiler, zena-formatter                                                                     |
| `packages/zena-compiler/zena/test`                               | wit-parser                                                                                        |
| `packages/zenadoc/zena/cli`, `zena/test`                         | zena-compiler                                                                                     |
| examples under `packages/protobuf`, `google-cloud`, `wit-parser` | their packages                                                                                    |

The compiler's own build is not among them: `zena-compiler/zena/cli/main.zena`
imports `../lib` by relative path, and the libraries there are in the
`zena-compiler` package.

Three ways to handle them:

1. **Read every manifest on the first name import from a file in no
   package.** No change to the rules. Every compile in the table still
   reads every manifest, which covers the CLI module, `lsp.wasm` and the
   compiler's tests.
2. **Give those directories manifests.** A manifest with no `name` and
   path dependencies makes `packages/zena-cli/zena` a package keyed by its
   directory, which sees only what it lists. No change to the rules; it
   is the repository adopting them where it has not.
3. **Files in no package see only the root manifest's dependencies.**
   Explicit, and it removes the case from the loader entirely, but it
   breaks every script and example that imports a workspace package by
   name until the root manifest lists it.

Option 1 with option 2 for the directories in the table keeps the rules
and reads only the reached manifests in every build the repository runs.

### Errors the loader can no longer see

Two packages with one name are reported today wherever they are. A lazy
loader sees a duplicate only when both are loaded, and a malformed
manifest only when something reaches it. `check:workspace` would keep
reporting both, by loading every manifest on purpose.

### Component builds

`compileFile` passes the source of every WIT-backed package in the map
to the component encoder (`packagesWit`), name-sorted. A lazy map holds
only the WIT packages of the manifests read, so the set it passes can be
smaller. Whether a WIT package nothing imports changes a component's
bytes has to be checked before the change; if it does, the encoder
should take the WIT packages the program imports.

### The bootstrap

`build:cli` runs the checked-in bootstrap, which keeps reading every
manifest until a re-baseline (bootstrapping.md). That does not affect the
build graph, which lists the compiler's own manifests for `build:cli`
already.

## Sequencing

1. Put the map behind the loader interface, with an implementation that
   loads eagerly as today. No behavior change.
2. Load lazily, with option 1 for files in no package. Test that a
   compile of a package's file reads no other package's manifest (the
   `.deps` of a cached compile).
3. Add manifests to the directories in the table.
4. Re-baseline, so stage A is built by a lazy loader.
5. Add a test that compares each wireit script's manifests with the
   `.deps` of a compile of its entry point.

## Alternatives considered

- **Narrow the build's inputs and check the workspace separately.** What
  the repository does now (#533). It fixed the rebuilds and needs no
  compiler change, at the cost of hand-kept lists and the compile cache
  imprecision above.
- **Names in the root manifest.** A `workspace.packages` object mapping
  names to directories would let the loader find a package by name
  without reading the others, which answers the files-in-no-package case.
  It duplicates every package's `name` in the root, and the two can
  disagree. `zena-packages.json`, which the manifests replaced, worked
  this way.

## Timing

Worth doing when manifest edits become frequent enough that the compile cache's
invalidation costs something: in a workspace with many packages that
runs `zena add` and `zena update` often, or when the hand-kept lists in
the build drift more than once.
