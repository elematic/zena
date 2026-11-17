# Tools

One command, `zena`, holds the compiler, test runner, formatter, linter,
documentation extractor, language server and package manager.
`zena --help` and `zena <command> --help` are the reference; this page is
the orientation.

Install: `curl -fsSL https://zena-lang.dev/install.sh | sh` (macOS and
Linux) or `irm https://zena-lang.dev/install.ps1 | iex` (Windows). In a
checkout of the Zena repository the command is `./target/release/zena-cli`.

## Commands

| Command                                  | What it does                                                                                       |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------- |
| `zena run file.zena [args]`              | Compile, through a cache, and run. Options go before the file; what follows it goes to the program |
| `zena build file.zena -o out.wasm`       | Compile. `-o out.wat` writes text. `-t` picks the target                                           |
| `zena test [paths] [-f substring]`       | Run `*_test.zena` files in parallel. With no path, the package's tests                             |
| `zena fmt -w files` / `zena fmt --check` | Format in place, or list files that are not formatted. Read its diff: see "Formatting"             |
| `zena lint paths` / `zena lint --fix`    | Report idiom findings as `path:line:column: message [rule]`, or rewrite. `--list-rules` lists them |
| `zena doc dir [-o api.json]`             | A package's public API as JSON                                                                     |
| `zena pkg …`                             | `init`, `add`, `update`, `fetch`, `publish` and the rest of package management                     |
| `zena lsp`                               | A language server on stdin and stdout                                                              |
| `zena bench suite.json`                  | Run a benchmark suite                                                                              |

Global options go before the command: `zena -g run …` names functions in
backtraces and turns on `debug` contract clauses, and `zena -O 2 build …`
sets the optimization level (`0`, `1`, `2`, `s`; the default is `1`).

## Formatting

`zena fmt` is behind the language. On code that uses newer syntax it has
changed the meaning: it printed the pattern `1 | 2 | 3` as `1 || 2 || 3`,
removed parentheses around a cast, and dropped the `operator` keyword.
Format a file only where the project already does, then build and read the
diff.

## Checking code

There is no separate type-check command. `zena build file.zena -o out.wasm`
reports every type error, as `path:line:column - Error: message`, and writes
nothing when there are any. `zena test` compiles each test file the same
way.

Run the smallest thing that answers the question. A five-line file under
the package with a `main` that returns or logs a value settles what a
feature does faster than reading about it.

## Programs

`main` is the exported entry point. Its `i32` result is the exit code. It
can be `async`.

```zena
import {getArguments} from 'zena:cli';
import {readFile} from 'zena:fs';

export async function main(): Future<i32> {
  let args = getArguments();
  if (args.length < 2) {
    console.error('usage: count <file>');
    return 2;
  }
  let text = await readFile(args[1]);
  console.log(`${text.split('\n').length} lines`);
  return 0;
}
```

A program runs in a sandbox. It sees no files, cannot spawn processes and
loads no extensions unless the command line grants them:

```sh
zena run --dir . count.zena notes.txt        # the current directory
zena run --dir /data::/in count.zena /in/a   # a host directory under a guest path
zena run --allow-spawn build.zena
```

## Packages

A package is a directory with a `zena-package.json`. `zena pkg init` writes
one. Libraries live in `src/`, and tests conventionally in `test/`.

```
my-package/
  zena-package.json     {"name": "my-package", "version": "0.1.0"}
  src/main.zena         imported as 'my-package'
  src/parse.zena        imported as 'my-package/parse'
  test/parse_test.zena
```

- A library imports its neighbors by relative path, with the extension:
  `import {parse} from './parse.zena';`.
- Tests and other packages import by package name:
  `import {parse} from 'my-package/parse';`. A package with a `scope` is
  `'scope:name/parse'`.
- `zena pkg add <package>[@version]` adds a dependency to the manifest and
  pins it in `zena-lock.json`.
- `"exports"` in the manifest limits which libraries other packages may
  import. `"dependencies"` maps a local name to `{"path": "../other"}` or a
  published package.

## Tests

A test file is named `*_test.zena` and exports `tests`. `zena test` with no
arguments finds `test/**/*_test.zena` and `tests/**/*_test.zena`.

```zena
import {suite, test} from 'zena:test';
import {equal, isTrue, throws} from 'zena:assert';

function half(n: i32): i32 requires (n % 2 == 0) {
  return n >> 1;
}

export let tests = suite('half', () => {
  test('halves an even number', () => {
    equal(half(10), 5);
  });

  // A failed clause throws ContractError.
  test('rejects an odd number', () => {
    throws(() => {
      half(3);
    });
  });

  test('can await', async () => {
    isTrue(await Future.of(true));
  });
});
```

`zena test test/parse_test.zena` runs one file, and `-f` filters by a
substring of the file's path. `debug` contract clauses are on under `zena
test`.

## Build targets

| `-t`             | Output                  | Runs on                                           |
| :--------------- | :---------------------- | :------------------------------------------------ |
| `zena-component` | Component (the default) | `zena run`, and hosts that embed the Zena runtime |
| `component`      | Component over WASI 0.3 | `wasmtime run -S p3=y`, other component hosts     |
| `js`             | Core module             | A JavaScript engine, with no runtime library      |
| `zena-js`        | Core module             | Browsers and Node.js with `@zena-lang/runtime`    |
| `core`           | Core module             | Any WebAssembly GC engine; no host imports        |

Some libraries exist only on some targets (`zena:fs` needs a component
target). `--wit` and `--world` give a component build a WIT world to
implement. Host functions on a core target are declared with
`@external("module", "name") declare function f(x: i32): void;`.

## Debugging

- A type error names a line and column. Fix the first one first: later
  ones are often its consequences.
- For a trap or an uncaught error, run with `zena -g run` to get function
  names in the backtrace. See "Failures at run time" in
  [pitfalls.md](pitfalls.md).
- `console.log` takes strings and primitives, and a template literal
  formats any primitive: ``console.log(`n=${n}`)``.
- To see what the compiler produced, build to `.wat`.
- `zena run --no-cache` and `zena build --no-cache` compile again when a
  cached result looks stale.
