# Asynchronous compiler I/O

## Status

Proposed 2026-11-04, implemented 2026-11-08. The two changes it waited
on, described under "Prerequisites", landed first: asynchronous test
bodies in `zena:test`, and elematic/zena#633. The sections below
describe what was built; "Verification" records what was measured.

## Overview

The compiler reads source through `CompilerHost`
(`packages/zena-compiler/zena/lib/library-loader.zena`), whose two
methods are synchronous:

```zena
interface CompilerHost {
  readFile(path: String): String;
  listDir(path: String): Array<String> | null;
}
```

The hosts that read from disk call `zena:fs`'s `Sync` forms, which wait
for the asynchronous WASI 0.3 call in `blockOn`
([async-fs-cli.md](./async-fs-cli.md)). This document makes every
compiler operation that reaches a host return a `Future`: the host
interface, the library loader, `Compiler.compile`, `compileFile`, and
the tools and the language service that call them. Type checking and
code generation do no I/O and stay synchronous.

The change is wanted for four reasons:

- A host that cannot answer synchronously can serve the compiler. In a
  browser, the language service gets the standard library from an
  in-memory map built ahead of time (`createVirtualFileReader`), because
  `FileReader` has to return a string. With an asynchronous host it can
  fetch a library when the compiler asks for it.
- The compiler can read from disk where `blockOn` traps. A `Sync` form
  works only inside a task the host lifted `async`, so a compile
  started from a component's synchronous export traps at its first
  read.
- A compile stops holding its task while a read is in flight. The
  language server reads one message, handles it, and reads the next; a
  read inside `blockOn` holds that loop.
- A compiler that hands work to another Wasm instance has to await the
  answer. Parsing or code generation in workers therefore needs these
  signatures first.

It does not make a build faster. See "Measurements".

## Measurements

`zena build --time packages/zena-cli/zena/main.zena` at `-O1`, measured
on 2026-11-04 with a `zena-cli` built from the branch that became #898.
Two runs agreed to within 4%; the machine's load average was 4 on 16
cores.

| phase            | time   |
| ---------------- | ------ |
| load (367 files) | 0.34 s |
| parse            | 0.91 s |
| scope analysis   | 0.65 s |
| check            | 1.7 s  |
| code generation  | 69.7 s |
| total            | 73.3 s |

Reading source is 0.5% of the compile, about 0.9 ms a file, so issuing
reads concurrently would save at most a third of a second. Parsing,
scope analysis and checking together are 4.4%. Work on parallelism
should start from code generation, which is 95%.

## Scope

"I/O" here means a call that reaches a host and can wait: reading a
file, listing a directory, testing whether a path exists, writing the
output. Three things the compiler also asks a host for stay
synchronous:

- `console` output, which is synchronous by design
  ([async-fs-cli.md](./async-fs-cli.md), "`zena:console`").
- `getEnv` and the command line, which are synchronous WIT functions.
- The clock behind `--time`.

A function that becomes asynchronous uses the asynchronous `zena:fs`
forms for its own I/O. A function that stays synchronous keeps the
`Sync` forms. So `zb`, the package manager's commands and the other
tools that do not call the compiler are unchanged.

## Detailed design

### `CompilerHost`

```zena
interface CompilerHost {
  readFile(path: String): Future<String>;
  listDir(path: String): Future<Array<String> | null>;
}
```

A missing file fails the future, as it throws today. There are eleven
implementations: `FileHost` (`compile-file.zena`), `DiskHost`
(`fs-host.zena`), `DocumentHost` (the language service), `ManifestHost`
(`zena-cli`'s `lsp.zena`), the hosts in `zenadoc` and `zena-lint`, and
five in the compiler's tests and benchmarks. A host that holds its
sources in memory declares the methods `async` and returns directly.

### Library loader

`LibraryLoader.load`, `#register` and `refreshCache` are
asynchronous. `loadSynthesized` is too, because it loads the imports of
the module it is given, and so is `invalidate`, which re-reads the file
it evicts so that an importer's cached record still finds it at the
next compile. `delete`, `has`, `get` and `computeGraph` read and edit
the cache only and stay synchronous.

The loader reads a library's imports together and parses them in
source order. Once a library is parsed, `#register` resolves every
import it names and starts a read of each one that is not loaded
(`#startRead`, one read per path, shared by every importer that asks
while it is in flight); then it awaits the reads in the order the
imports are written and registers each in turn, so a nested library's
own imports start reading while its siblings' reads are still out. The
parse order is what matters: every parse draws node ids from one
generator and interns identifiers in one `StringTable`, both owned by
the loader, node ids key the semantic model, and their order reaches
the emitted module. The reads' completion order changes nothing, since
a read is used only at its turn. `refreshCache` reads every cached user
file the same way. The first change landed with the reads one at a
time, and the second made them concurrent; both emit the same bytes as
the synchronous compiler did.

The reads in flight are bounded by the import lists along the current
path of the depth-first load, so a program with hundreds of libraries
has tens of reads out, not hundreds. The map of in-flight reads is
cleared when a load starts: a read a failed load left behind would
otherwise serve the next load stale text.

A failed read of an import leaves the import for the checker to report
as a missing library. The `await` sits inside that `try`.

### One compile at a time

A `Compiler` holds mutable state for each target: the loader's cache,
the id generators and the scope trees. A synchronous `compile` could not
be interrupted. An asynchronous one can: while it waits for a read, the
caller is free to call `compile` or `invalidate` on the same compiler,
and the second call would see a cache the first has half filled.

`Compiler.compile` and `Compiler.invalidate` throw when a compile is in
flight on that compiler. The batch drivers (`CompileSession`, the
portable test runners, `zenadoc`) await each compile before starting
the next, so they never reach the check. The language service is the
one caller whose requests can overlap, because JavaScript can call
`check` twice without awaiting the first. `LanguageService` queues its
two asynchronous methods, `check` and `checkProgram`, and runs them in
arrival order.

### Package manifests and WIT

`loadWorkspace` (`package-manifest.zena`), `readWitDocument` and
`readWitSource` (`wit-source.zena`) and `synthesizeWitModule`
(`wit-module-synth.zena`) read through the host and become
asynchronous. `FileHost.readFile` awaits `synthesizeWitModule` for a
WIT-backed module.

### `Compiler` and `compile-file.zena`

```zena
Compiler.compile(options: CompileOptions): Future<CompilationResult>
openCompileSession(options): Future<CompileSession | null>
CompileSession.compile(entry, outPath): Future<i32>
compileFile(options): Future<i32>
compileComponentRuntimeModule(compiler, stdlibRoot): Future<ByteBuffer>
```

`CompilerTarget.compile` awaits the loads of the prelude, the entry and
the target's runtime libraries, then runs scope analysis and import
wiring synchronously as it does now. `checkCompilation`, the
generators and everything under `lib/codegen/` keep their signatures,
with one exception: `compileComponentRuntimeModule` compiles the
component's memory module with `compiler.compile`, so it is
asynchronous, and `CompileSession` awaits it before it constructs the
generator.

`compile-file.zena`'s own calls move to the asynchronous forms:
`exists` for the WIT path and the package roots, `readFileBytes` for a
prebuilt runtime memory module, `writeFile` and `writeFileBytes` for
the output.

### Command-line tools

The compiler's `main` (`zena/cli/main.zena`) and `zena-cli`'s `main`
become `async function main(): Future<i32>`. The commands that compile
(`build`, `run`, `test`, `bench`, `lint`, `doc`, `lsp`) become
asynchronous down to the call that reaches the compiler. That takes in
`compileTo`, `compileCached` and `compileIntoCache` in `zena-cli`'s
`compile.zena`, `zenadoc`'s `documentPackage`, and `zena-lint`'s
`Project` (`checking.zena`), which type-checks each fix before keeping
it.

The portable test runners (`portable_syntax`, `portable_semantics`,
`portable_execution`) embed the compiler and get an asynchronous `main`
the same way.

### Language service

`LanguageService.check` and `checkProgram` compile, so they return
futures, and so does `compileToWasm` (`lib/compile.zena`), which calls
`checkProgram`. The other methods stay synchronous: `lint`, `fixAll`,
`getDefinition`, `getHover` and `getCompletions` read the results of
the last check, `getDocumentSymbols` parses the text it is given, and
`openDocument` and `closeDocument` edit the host's document map.

`LspServer.handle` is asynchronous, and so is `MessageReader.next`,
which reads standard input with `readStdin`. `zena lsp`'s loop awaits
each message before reading the next, which keeps the order messages
were answered in.

`lsp.wasm` is built for the `js` target, where a Wasm export returns a
Wasm value and cannot return a `Future` the host could use. Each
asynchronous export in `lsp.zena` (`init`, which reads the workspace's
manifests, `check` and `compileToWasm`) therefore returns the
JavaScript promise that `zena:js`'s `toPromise` makes from its future.
The file reader import
(`compiler.read_file`) becomes an asynchronous import registered
through `@zena-lang/runtime`'s `asyncImports`, so the package
instantiates `lsp.wasm` with the runtime's `instantiate` in place of
its own.

The published JavaScript API of `@zena-lang/language-service` changes
to match:

```ts
type FileReader = (
  path: string,
) => string | undefined | null | Promise<string | undefined | null>;

class ZenaLanguageService {
  check(path: string, source?: string): Promise<Diagnostic[]>;
  lint(path: string, source?: string): Promise<LintFinding[]>;
  hover(
    path: string,
    offset: number,
    source?: string,
  ): Promise<HoverInfo | null>;
  completions(
    path: string,
    offset: number,
    source?: string,
  ): Promise<CompletionItem[]>;
  definition(
    path: string,
    offset: number,
    source?: string,
  ): Promise<DefinitionInfo | null>;
  documentSymbols(path: string, source?: string): Promise<DocumentSymbolInfo[]>;
  compileToWasm(
    path: string,
    source?: string,
  ): Promise<Uint8Array<ArrayBuffer> | null>;
}
```

Every method that may analyze a document returns a promise: `lint`,
`hover`, `completions` and `definition` check the document first when
they are given a source, and `documentSymbols` reads it through
`readFile` when it is not open. `format`, `openDocument` and
`closeDocument` stay synchronous. The callers are the playground's
compiler worker, which already answers over messages, the VS Code
extension's `compiler-service.ts`, which binds `lsp.wasm`'s exports
itself, and the test harnesses in `@zena-lang/runtime` and
`wasm-web-ui` that compile fixtures through `lsp.wasm`; each gives the
module the `js` promise imports and a host-async `read_file`.

### Tests

The compiler's tests call the changed functions at about 230 sites in
about 50 files. Each such test body is asynchronous and awaits the
compile; `zena:assert` gained `rejects`, the `throws` of an
asynchronous function, for the tests that expect a compile to fail.
`MockHost` and `PlainHost` (`test-utils.zena`) return their in-memory
sources from `async` methods.

## Prerequisites

Both are done.

**Asynchronous test bodies.** `zena:test` ran a test by calling
`fn(ctx)` and treated its return as the end of the test. `test` now
accepts a body that returns `Future<void>`, the runner awaits each test
before the next, `runAndReport` returns `Future<i32>`, and the `main`
the compiler appends to a test file in test mode is asynchronous
([testing.md](./testing.md), "Synchronous and Asynchronous Test
Bodies"). Without this, each compiler test would wait in `blockOn`,
which exists only on the component targets.

**elematic/zena#633.** Passing a record to a parameter of a wider
record type failed in code generation inside an `async` function.
`compiler.compile({entry, target})` is that case once its caller is
asynchronous: `CompileOptions` has optional fields the literal leaves
out. Fixed in elematic/zena#905.

## Landing order

1. The two prerequisites (done).
2. A probe of the bootstrap. The compiler's own source has no `async`
   function today. The bootstrap already compiles the ones in `zena:fs`,
   which the `Sync` forms call, so asynchronous functions and `await`
   are known to work. Asynchronous methods called through an interface
   and asynchronous private methods are new to it. If the bootstrap
   cannot compile them, the change lands in two steps with a reseed
   between, as [bootstrapping.md](./bootstrapping.md) describes.
3. The change itself, as one pull request. `Compiler.compile`'s new
   return type breaks every caller in the same commit, and `lsp.wasm`
   cannot keep a synchronous path beside the asynchronous one because
   the `js` target has no `blockOn`.

## Verification

- `npm test` passes, the stage B and stage C comparison included.
- A compiler built from the branch's base and one built from the
  branch, each compiling the same inputs through `ZENA_COMPILER_WASM`
  (`packages/zena-compiler/CONTEXT.md`, "Debugging the compiler"),
  emit identical bytes: two small programs with an async `main`, the
  compiler's `cli/main.zena` (2.2 MB), zenadoc's `main.zena` (1.0 MB)
  and the `zena` command's `main.zena` (3.0 MB). The baseline has to be
  the merge base: a first comparison against a later `main` differed
  by a permutation of two canon imports, which a commit on `main` to
  the component adapters accounted for.
- The `load` line of `--time` is unchanged in kind: the compiler's own
  `cli/main.zena` reads its 222 files in 0.31 s through the
  asynchronous reads, where the measurement above read 367 files in
  0.34 s through `blockOn`.
- `lsp.wasm` grew from 2.36 MB to 2.46 MB. That figure compares against
  an older `main`, so other commits are in it; the `zena:js` promise
  support and the futures in the compiler are the part this change
  adds.

## Later work

These are outside this change and depend on it.

- **Parallel parsing.** With the reads concurrent, parsing is still
  sequential because node ids come from one generator. Numbering nodes
  per file would let a worker parse a file on its own.
- **Workers.** Wasm GC objects cannot be shared between instances, so a
  worker's result crosses as bytes. Code generation already produces
  bytes; a worker that parses would have to serialize its AST.
- **Language server responsiveness.** Reading the next message while a
  compile is in flight, and cancelling a compile that a newer edit has
  made obsolete.

## Alternatives considered

**A synchronous compiler behind an asynchronous prefetch.** The caller
would fetch every source first and hand the compiler an in-memory host.
The set of files is known only by parsing each one for its imports, so
the prefetch would need its own import scanner and module resolver, or
a loop that compiles, collects the missing paths, fetches them and
compiles again. Rejected because it keeps two paths through resolution
and still leaves the compiler unable to await a worker.

**Synchronous entry points beside the asynchronous ones.** A
`compileSync` that waits in `blockOn` would spare the tools and tests
this change. It would work only on the component targets and only
inside an `async`-lifted task, and it would be a second path to keep
correct. Rejected for the same reason the repository keeps no
compatibility shims.

## Related

- [async-fs-cli.md](./async-fs-cli.md): the asynchronous `zena:fs`
  this builds on, and where `blockOn` traps.
- [async.md](./async.md): `async`, `await`, `Future`, and the `js`
  host's completion protocol.
- [bootstrapping.md](./bootstrapping.md): landing a compiler change the
  bootstrap cannot compile.
- [lsp.md](./lsp.md): the language server.
- [self-hosted-compiler.md](./self-hosted-compiler.md): the compiler's
  architecture, including `CompilerHost`.
