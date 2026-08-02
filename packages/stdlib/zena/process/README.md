# `zena:process`

Spawning host processes from Zena programs.

```zena
import {run, runIn, spawn} from 'zena:process';
import {Array} from 'zena:growable-array';

let argv = new Array<String>();
argv.push('git');
argv.push('status');

// Run to completion (optionally in a working directory with runIn).
let res = run(argv);
res.exitCode;   // i32 (-1 if killed by a signal)
res.stdout;     // String, fully captured
res.stderr;     // String, fully captured
res.wallNanos;  // i64, spawn-to-exit wall time

// Or start several and wait on each — this is how callers run work in
// parallel.
let a = spawn(argvA);
let b = spawn(argvB);
let ra = a.wait();
let rb = b.wait();
```

## Capability model

WASI cannot create processes, and spawning is a deliberate escape from
the WASI sandbox, so this library is a **host capability**, not a plain
stdlib module:

- **Compile time**: `zena:process` is a virtual module mapped only for
  the `wasi` and `zena-cli` targets. There is no `host` (JS) mapping.
  The `wasi` mapping exists because artifacts compiled `--target wasi`
  are still routinely *executed* by zena-cli — the stdlib test runners
  are built that way (`build-wasi-tests.js`), and the process tests run
  through them. It also keeps the imports embedder-neutral: the module
  compiles against a plain import contract (`zena_process`), so any
  other WASI host could grant the same capability by providing those
  imports; under a host that doesn't (e.g. the `wasmtime` CLI),
  instantiation fails with an unknown-import error, which is the
  capability model working as intended.
- **Run time**: only the `zena-cli` host implements the `zena_process`
  wasm imports, and only for invocations it trusts — its own
  orchestrator programs (the bench and test runners) and repo tests get
  real implementations; `zena-cli run` links them only with
  `--allow-spawn` (or `ZENA_ALLOW_SPAWN=1`). Everything else gets stubs
  that trap with an explanatory message on first call, so merely
  importing the library never breaks a program that doesn't use it.

## Semantics

- `argv[0]` is the executable, resolved against `PATH` by the host.
- The child inherits the host's environment, and its working directory
  unless `runIn`/`spawnIn` pass one.
- Both output streams are fully captured (no streaming in v1) and
  buffered by the host until `wait()`.
- `wait()` blocks; calling it again returns the same result. A process
  that could not be started at all (executable missing) traps with a
  descriptive message from `wait()`.
- Handles are opaque host references — the guest GC owns their
  lifetime; there is nothing to close.

## Implementation notes

The host side lives in `packages/zena-cli/src/process.rs`. Strings
cross the boundary through the `$stringCreate` / `$stringSetByte` /
`$stringGetByte` / `$stringGetLength` helpers every compiled Zena
module exports; handles cross as `externref`s wrapping host state.
Consumers in-repo: `bench-run.zena` (the benchmark orchestrator) and
`test-run.zena` (the test-runner pool), both under
`packages/zena-cli/zena/`.
