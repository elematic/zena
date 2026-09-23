# The CLI Module

## Status

- **Status**: Proposed
- **Date**: 2026-09-23

The `zena` command is a Zena program. It is compiled to one Wasm module,
the **CLI module**, which holds everything the command does: reading the
command line, compiling, running programs, running tests, building
targets, documentation, formatting, and a language server. The Rust
binary `zena-cli` loads that module and gives it a small set of host
imports; it contains no command-line logic of its own.

## The command today

`zena-cli` is a Rust program with a Zena compiler inside it. clap reads
the command line, the `glob` and `walkdir` crates find test files, and
Rust decides what to compile and in what order. The compiler, the test
orchestrator (`packages/zena-cli/zena/test-run.zena`), the benchmark
orchestrator, and zenadoc are Zena programs that the Rust side compiles
and runs one at a time. The test runner starts one `zena-cli` process
per test file, and each of those processes compiles and runs its test
in Rust.

So the logic is split across two languages, and the Zena half cannot do
much without calling back into Rust.

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
| `zena bench`              | `zena:bench`, and the host import that runs a module |
| `zena lsp`                | the language service, and a JSON-RPC loop over stdio |

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

The CLI module imports four things from its host:

- **WASI preview 1**, for files, the environment, the clock and stdio.
- **The stack-trace imports** that `Error` uses.
- **`zena_process`**, to spawn host processes. zb runs build commands
  through it, and `zena bench` runs command variants through it.
- **A new import that runs a Wasm module.** This is what Wasm cannot do
  for itself: start wasmtime on another module. The test runner needs it
  to run each compiled test.

All four live in the `zena-runtime` crate, so `zena-run` provides the
same set. File watching, which zb's watch mode needs, will be a fifth
import when that lands; see [workflow.md](./workflow.md#file-watching).

### Running a module

The Zena side sees a library, `zena:wasm`, in the shape of
`zena:process`. Roughly (the exact names are settled in the change that
adds it):

```zena
import { loadModule, startModule, RunOptions } from 'zena:wasm';

let module = loadModule('/work/zena/.zena/cache/array_test_1f2e.wasm');
let run = startModule(module, new RunOptions()
  .withArgs(['array_test'])
  .withDir('/work/zena', '.')
  .capturingOutput());
let result = run.wait();
// result.exitCode, result.trapped, result.message, result.backtrace,
// result.stdout, result.stderr, result.callNanos
```

- `loadModule` reads a `.wasm` file. The host keeps the `.cwasm` cache
  next to it, as it does today, including the file lock that stops
  twenty processes from running Cranelift on the same module at once.
- `startModule` returns straight away. The host runs the module on its
  own thread with a fresh store, so several can run at once. Options
  cover the arguments, the environment, preopened directories, whether
  the module may spawn processes or run modules itself, whether its
  stdio is captured or connected to the terminal, and a time limit.
- `wait` blocks until the run ends. A trap is reported in the result;
  it does not propagate to the caller. The result includes the time the
  exported call took, excluding instantiation, which is the measurement
  `zena bench` needs.

Running a module is granted together with spawning. A module that can
run another module can give it any preopened directory, so it has the
same reach as a process. A module started without the grant gets
trapping stubs, as `zena_process` does today.

The time limit uses wasmtime's epoch interruption. That changes the
code Cranelift generates for every module, so turning it on invalidates
every cached `.cwasm` once and costs a small amount of speed. That cost
is measured in the change that adds it before it is kept.

## What each command does

### `zena build`

`zena build` takes either a file or a build target.

- `zena build main.zena -o main.wasm` compiles one file. The argument
  names an existing `.zena` file, so it is read as a file.
- `zena build` with no argument runs the `build` target of the package
  the user is in.
- `zena build test` runs that package's `test` target, and
  `zena build packages/zb:test` runs the `test` target of another
  package, in the `<package>:<script>` form wireit dependencies use. zb
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

`zena run` and `zena test` compile through a cache, so a file that has
not changed since the last run is not compiled again. The cache moves
from Rust into the CLI module:

- The cache key is a hash of the source path, the compile flags, the
  CLI module's own identity, and the path, modification time and size of
  every source file the compile can read. Modification times come from
  WASI's file stat. `zena:fs`'s `FileStat` gains a `modified` field for
  them.
- An entry is written to a temporary file and renamed into place, so a
  reader never sees half an entry. `zena:fs` gains `rename` for this.
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
2. Compile each file in test mode, through the cache. Compiles run in
   parallel by starting copies of the CLI module itself with
   `zena:wasm`, each told to compile one file.
3. Run each compiled test with `zena:wasm`, with output captured, a
   bounded number at a time, and report pass or fail in file order.

Each test runs in a fresh store. A trap is caught and reported with its
backtrace; the memory the test used goes away with its store; a test
that runs past its time limit is stopped. There is no process per test.

A later version can keep one compiler warm across several test files,
which [workflow.md](./workflow.md#zena-compiler-integration) plans for
as the compile server. The first version starts a fresh copy per compile,
which keeps compiles independent and parallel.

### `zena lsp`

`zena lsp` is a language server that speaks LSP (JSON-RPC over stdin and
stdout), for editors that start a server process: Neovim, Helix, Zed and
others. It uses the same analysis code as `lsp.wasm`. That code moves
into a library both entry points import; `lsp.zena` keeps the exports
VS Code calls, and the CLI module adds the JSON-RPC loop. Reading stdin
needs a small addition to `zena:fs` or `zena:cli`.

## The host binary

With all of that in the module, `zena-cli` does what `zena-run` does,
plus three things:

- It finds the CLI module. In a checkout that is the built module under
  `packages/zena-cli`; an installed copy keeps the module next to the
  binary.
- It grants the module the spawn capability and preopens `/`, because
  the command works with files anywhere the user points it.
- It tells the module which directory the user ran it from, since the
  module's working directory is its preopen.

That is a few dozen lines of Rust. It could be a shell script around
`zena-run`; it stays a binary so that installing `zena` is one file plus
the module.

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

The extra compile in a clean build is measured when the CLI module
first builds. If it matters, this alternative can be taken later with
one reseed.

## Changes to land

Each is one pull request:

1. **Running a module.** The `zena:wasm` library and its host import in
   `zena-runtime`, with the time limit and its measured cost. `zena:fs`
   gains `modified` and `rename`. `zena:process` gains inherited stdio.
2. **The CLI module.** `zena build` (files and targets), `run`, `test`,
   `doc`, `fmt` and `bench`, with the compile cache in Zena. The build
   steps above. `zena-cli` becomes the small host. This replaces the
   open pull request #657, whose command-line parsing and test
   discovery carry over.
3. **`zena lsp`.** The shared analysis library, the JSON-RPC loop, and
   reading stdin.

## Open questions

- **Installed layout.** Whether an installed `zena-cli` embeds the
  module in its binary or keeps it as a file beside it. A file is
  simpler to build; embedding makes the install one file.
- **The standard library at run time.** The compiler reads the standard
  library's source when it compiles. In a checkout it is in
  `packages/stdlib`; an installed toolchain needs a copy, as the Nix
  package keeps one today.
