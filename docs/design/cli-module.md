# The CLI Module

## Status

- **Status**: Implemented, except `zena lsp`
- **Date**: 2026-09-23; updated 2026-09-29

The `zena` command is a Zena program. It is compiled to one Wasm
component, the **CLI module**, which holds everything the command does:
reading the command line, compiling, running programs, running tests,
building targets, documentation, formatting, and (still to come) a
language server. The Rust binary `zena-cli` loads that component and
gives it a small set of host imports; it contains no command-line logic
of its own.

The source is `packages/zena-cli/zena/`: `main.zena` reads the command
line and dispatches to `compile.zena`, `run.zena`, `test-run.zena` and
`bench-run.zena`, and `env.zena` holds what the host tells the module.

## The command before

`zena-cli` was a Rust program with a Zena compiler inside it. clap read
the command line, the `glob` and `walkdir` crates found test files, and
Rust decided what to compile and in what order. The compiler, the test
orchestrator, the benchmark orchestrator, and zenadoc were Zena programs
that the Rust side compiled and ran one at a time. The test runner
started one `zena-cli` process per test file, and each of those
processes compiled and ran its test in Rust.

So the logic was split across two languages, and the Zena half could not
do much without calling back into Rust.

## One module for the command

The CLI module contains:

| Command                   | What it uses                                         |
| ------------------------- | ---------------------------------------------------- |
| argument parsing and help | `zena:args`                                          |
| `zena build`, `zena run`  | the compiler, linked in as a library                 |
| `zena test`               | the compiler, and the host import that runs a module |
| `zena build <target>`     | zb, linked in as a library                           |
| `zena doc`                | zenadoc, linked in                                   |
| `zena fmt`                | the formatter, linked in                             |
| `zena bench`              | `zena:bench`'s `runSuite`, which runs modules        |
| `zena lsp` (to come)      | the language service, and a JSON-RPC loop over stdio |

The compiler, zb, zenadoc and the formatter are all Zena packages
already. The compiler's own command-line program
(`packages/zena-compiler/zena/cli/main.zena`) is about 400 lines around
the compiler library, and the language service
(`packages/language-service/zena/lsp.zena`) already uses that library
directly. Putting them in one module means calling those libraries from
one `main`.

This module is for the command line only. Other programs build their
own entry points from the same libraries:

- The VS Code extension keeps its own module, `lsp.wasm`, which holds
  the language service and nothing else. The extension loads it and
  calls its exported functions through VS Code's APIs, and runs in the
  browser (vscode.dev) with nothing installed. It has no use for the
  test runner or zb.
- The playground keeps its module for the browser.
- A program that wants only the compiler links only the compiler.

## The host surface

The CLI module is a component, and it imports four things from its
host:

- **WASI 0.3**, for files, the environment, the clock and stdio.
- **`zena-cli:host/stack-trace`**, the `capture` function behind
  `Error`'s stack traces on this target.
- **`zena-cli:host/process`**, to spawn host processes. zb runs build
  commands through it, and `zena bench` runs command variants through
  it.
- **`zena-cli:host/wasm`**, which runs another component. This is what
  Wasm cannot do for itself: start wasmtime on another component. The
  test runner needs it to run each compiled test.

The three `zena-cli:host` interfaces are declared in
`packages/stdlib/zena/host-wit/host.wit` (package `zena-cli:host@1.0.0`)
and implemented in the `zena-runtime` crate
(`packages/zena-runtime/src/component.rs`), so `zena-run` provides the
same set. File watching, which zb's watch mode needs, will be a further
import when that lands; see [workflow.md](./workflow.md#file-watching).

### Running a module

The Zena side sees a library, `zena:wasm`, in the shape of
`zena:process`:

```zena
import { milliseconds } from 'zena:time';
import { startModule } from 'zena:wasm';

let run = startModule('.zena/cache/array_test_1f2e.wasm', {
  args: ['array_test'],
  dirs: [{from: '.', to: '.'}],
  timeout: milliseconds(60000 as i64),
});
let result = run.wait();
// result.outcome (Returned, Exited, Trapped, TimedOut or Failed),
// result.exitCode, result.resultText, result.message, result.stdout,
// result.stderr, result.callTime
```

`Returned` means the exported function returned, and `resultText` is its
first result as `zena run` prints it (`7`, `2.5`). `Exited` means the
module called `exit`, so `zena run` can end with the same status.

- `startModule` returns straight away. The host loads the module through
  the `.cwasm` cache it keeps today, including the file lock that stops
  twenty processes from running Cranelift on the same module at once,
  and runs it on its own thread with a fresh store, so several can run
  at once. Options cover the arguments, the environment, preopened
  directories, whether the module may spawn processes or run modules
  itself, whether its stdio is captured or connected to the terminal,
  and a time limit.
- `wait` blocks until the run ends. A trap is reported in the result
  with its backtrace; it does not propagate to the caller. The result
  includes the time the exported call took, excluding loading and
  instantiation, which is the measurement `zena bench` needs.

Running a module is granted together with spawning. A module started
without the grant gets trapping stubs, as `zena:process` does.
Paths are in the caller's own view of the filesystem: the module's path
and every directory handed to it are translated through the caller's
preopens, and a path outside them, or one with a `..` segment, makes the
run fail to start. So a module can pass on only what it can reach
itself.

The time limit uses wasmtime's epoch interruption: compiled code checks
a counter at function entries and loop back edges, and a thread advances
the counter. On the compiler compiling itself, the median CPU time over
five alternating rounds was 44.3 s without it and 46.7 s with it, but
rounds of the same binary spread by about 10% on the machine measured, so
the cost is somewhere from nothing to a few percent. The normal engine
therefore stays without it, and a run that asks for a time limit uses a
second engine that has it on, created once per process. Programs that
never ask for a limit pay nothing. The second engine's compiled modules
are cached under their own `.cwasm` name, because wasmtime refuses a
`.cwasm` compiled with different settings.

## What each command does

### `zena build`

`zena build` takes either a file or a build target.

- `zena build main.zena -o main.wasm` compiles one file. The argument
  names an existing `.zena` file, so it is read as a file.
- `zena build` with no argument runs the `build` target of the package
  the user is in.
- `zena build test` runs that package's `test` target, and
  `zena build ./packages/zb:test` runs the `test` target of another
  package, in the `<path>:<script>` form wireit dependencies use. As in
  wireit, the leading `./` is what marks the part before the colon as a
  path, so `test` alone is always a script of the current package. zb
  reads the targets from each package's wireit configuration and runs
  them.

A file argument always compiles exactly that file, with the enclosing
package's settings (its package map and default target). It never runs
a target, even when some target builds the same file with other flags.
Wireit targets are shell commands, so zb cannot reliably tell which of
them builds a given file. When zb has built-in build rules, which
declare their inputs instead of running a shell command (see
[workflow.md](./workflow.md#rules)), `zena build` can name the target
that builds a file the user compiled directly.

### The compile cache

`zena run`, `zena test` and `zena bench` compile through a cache, so a
file that has not changed since the last run is not compiled again. The
cache is in the CLI module (`compile.zena`):

- An entry is the compiled module plus a `.deps` file listing every
  file the compile read, each with its modification time and size. The
  compiler reports each file through an `onRead` hook on
  `CompileFileOptions`, just before reading it, so an edit made during
  the compile leaves the entry stale. The entry is fresh while every
  listed file still matches.
- The entry's name is a hash of the source path, the compile flags and
  the compiler's identity: the CLI module's own path, modification time
  and size, since the compiler is part of it.
- The module and its `.deps` file are each written to a temporary file
  and renamed into place, so a reader never sees half an entry.
- `zena build` always compiles, because running it is the request to.
- Two `zena` processes that compile the same file at the same moment
  both compile it, and the second rename wins. Both results are correct;
  the cost is one duplicate compile in a rare race. Within one process
  the test runner compiles each file once.

### `zena run`

`zena run main.zena` compiles through the cache and then runs the
module with `zena:wasm`, with stdio connected to the terminal. A `.wasm`
argument is run as it is.

### `zena test`

The test runner is Zena from end to end:

1. Find the test files: each argument is a file, a directory (meaning
   every `_test.zena` beneath it) or a glob, found with `zena:fs`'s
   `glob`.
2. For each file, start a copy of the CLI module with `zena:wasm`, as
   `zena test --single <file>`, a bounded number at a time
   (`ZENA_TEST_PARALLELISM`, else the CPU count up to eight). The copy
   compiles the file in test mode through the cache, runs the compiled
   test with `zena:wasm`, and prints what the test printed.
3. Report each file in order as pass or fail, with its output when it
   failed.

Each copy and each test runs in its own store. A trap is caught and
reported with its backtrace, and the memory a test used goes away with
its store. There is no process per test.

A copy needs the variables the host set for the CLI module
(`ZENA_REPO_ROOT` and the rest). `zena:wasm`'s `inheritEnv` passes on the
host process's environment, which does not have them, so the runner
hands them over explicitly (`hostEnv()` in `env.zena`).

A later version can keep one compiler warm across several test files,
which [workflow.md](./workflow.md#zena-compiler-integration) plans for
as the compile server. For now each copy compiles its own file, which
keeps compiles independent and parallel.

### `zena bench`

A benchmark suite is a JSON config naming its variants: Wasm modules
(`wasm`, `wat`, or `zena` source) and commands. `zena:bench`'s
`runSuite` (`packages/stdlib/zena/bench/suite.zena`) samples them
round-robin, times a module's exported call with `zena:wasm`, runs a
command with `zena:process`, and writes the report. Compiling `zena`
variants is the one thing the library cannot do by itself, so the caller
passes a `compile` function; `zena bench` passes one that compiles
through the cache. See [benchmarking.md](./benchmarking.md).

### `zena lsp`

Not built yet. `zena lsp` is to be a language server that speaks LSP
(JSON-RPC over stdin and stdout), for editors that start a server
process: Neovim, Helix, Zed and others. It uses the same analysis code as
`lsp.wasm`. That code moves into a library both entry points import;
`lsp.zena` keeps the exports VS Code calls, and the CLI module adds the
JSON-RPC loop. Reading stdin needs a small addition to `zena:cli`.

## The host binary

With all of that in the module, `zena-cli` (`packages/zena-cli/src/main.rs`,
about 130 lines) does what `zena-run` does, plus three things:

- It finds the repository and the CLI module: `ZENA_REPO_ROOT`, else the
  checkout the binary was built in, and `ZENA_CLI_MODULE`, else
  `packages/zena-cli/out/zena.wasm` under it.
- It preopens the repository as `.`, first, because `zena:fs` resolves a
  relative path against the first preopen and the compiler reads
  `zena-packages.json` and the standard library relative to it. It
  preopens `/` as `/` too, because the command works with files anywhere
  the user points it, and grants the module the spawn capability.
- It tells the module what it cannot find out for itself, in environment
  variables: `ZENA_REPO_ROOT`, `ZENA_CWD` (the directory the user ran
  the command from, which relative paths on the command line are
  measured from), `ZENA_CLI_MODULE`, and `ZENA_AVAILABLE_PARALLELISM`
  (the CPU count).

It could be a shell script around `zena-run`; it stays a binary so that
installing `zena` is one file plus the module.

## Building the CLI module

The CLI module contains the compiler, so something has to compile it
first. The build order is:

```
cargo build                    → zena-run, zena-cli
zena-run + bootstrap/cli.wasm  → packages/zena-compiler/zena/out/cli.wasm
zena-run + zena/out/cli.wasm   → packages/zena-cli/out/zena.wasm   (the CLI module)
zena-cli (+ zena.wasm)         → everything else
```

The first two compiles are `zena-run` running a compiler with the right
preopens; no compile logic is needed in Rust. `bootstrap/cli.wasm`
stays what it is today, the compiler alone, and the rules in
[bootstrapping.md](./bootstrapping.md) are unchanged: the fixpoint gate
still checks the compiler compiling itself.

### Alternative considered: the CLI module as the bootstrap

The checked-in bootstrap could be the CLI module itself. Then
`zena-cli` plus the bootstrap would be a complete toolchain with no
separate compiler build, and a clean build would compile the compiler's
source once instead of twice.

It is not done here because:

- Every change to the command line, zb, zenadoc or the formatter would
  then be a change to what the bootstrap has to build and reproduce, and
  the fixpoint gate would cover all of it.
- The bootstrap would grow with every tool added to the command.
- The build order above needs no reseed to land.

The extra compile in a clean build has not been measured on its own
yet. If it matters, this alternative can be taken later with one
reseed.

## What landed

1. **Running a module** (#665). The `zena:wasm` library and its host
   import in `zena-runtime`, with the time limit on its own engine.
   `zena:fs` gained `modified` and `rename`, and `zena:process` gained
   inherited stdio.
2. **The CLI module** (#669). `zena build` (files and targets), `run`,
   `test`, `doc`, `fmt` and `bench`, with the compile cache in Zena, the
   build steps above, and `zena-cli` as the small host. The benchmark
   suite runner moved into `zena:bench` as `runSuite`.
3. **Components on WASI 0.3** (#684), which came after and moved
   everything above onto components: the CLI module, the bootstrap and
   every test are components, and the host's imports became the
   `zena-cli:host` WIT interfaces.

Still to come: **`zena lsp`**, with the shared analysis library, the
JSON-RPC loop, and reading stdin.

## Open questions

- **Installed layout.** Whether an installed `zena-cli` embeds the
  module in its binary or keeps it as a file beside it. A file is
  simpler to build; embedding makes the install one file.
- **The standard library at run time.** The compiler reads the standard
  library's source when it compiles. In a checkout it is in
  `packages/stdlib`; an installed toolchain needs a copy, as the Nix
  package keeps one today.
