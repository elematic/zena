# `zena:process`

Spawning host processes from Zena programs.

```zena
import {run, runIn, runWith, spawn, spawnWith} from 'zena:process';

let argv = new Array<String>();
argv.push('git');
argv.push('status');

// Run to completion (optionally in a working directory with runIn).
let res = await run(argv);
res.exitCode;   // i32 (-1 if killed by a signal)
res.stdout;     // String, fully captured
res.stderr;     // String, fully captured
res.wallNanos;  // i64, spawn-to-exit wall time
res.timedOut;   // boolean, true if killed for overrunning a deadline

// Bound how long a child may take. On the deadline it is killed, and
// the result carries timedOut with whatever it wrote beforehand.
let p = spawn(argv);
let bounded = await p.waitFor(30000 as i64);

// Or start several and wait on each — this is how callers run work in
// parallel.
let a = spawn(argvA);
let b = spawn(argvB);
let ra = await a.wait();
let rb = await b.wait();

// Options: a working directory, this program's own stdio, and text
// for the child's stdin, which is closed after it.
let sorted = await runWith(['sort'], {input: 'b\na\n'});
let ls = spawnWith(['ls'], {cwd: '/tmp'});
let inTmp = await ls.wait();
```

## Capability model

WASI cannot create processes, and spawning is a deliberate escape from
the WASI sandbox, so this library is a **host capability**, not a plain
stdlib module:

- **Compile time**: `zena:process` is a virtual module mapped only for
  the `zena-cli` target. There is no `js` or `component` mapping: a
  program that imports it is one the zena command runs. The module
  compiles against the `zena-cli:host@1.0.0` WIT the standard library
  carries (`host-wit/host.wit`), so any other host could grant the same
  capability by implementing that interface; under a host that doesn't
  (e.g. the `wasmtime` CLI), instantiation fails with an unknown-import
  error, which is the capability model working as intended.
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
  unless `runIn`/`spawnIn` or a `cwd` option pass one.
- The child's stdin is empty unless an `input` option gives it text; the
  host writes the text on a thread of its own and then closes stdin, so
  a child that writes before it has read everything cannot deadlock.
- Both output streams are fully captured (no streaming in v1) and read
  on their own host threads, so a child that fills one pipe while the
  parent is reading the other cannot deadlock.
- `wait()` returns a `Future<ProcessResult>` so other tasks in the
  program keep running while the child executes. Waiting again returns
  the same result. A synchronous caller inside `main` or a test body can
  wait on it with `runFuture` from `zena:async`.
- `waitFor(millis)` bounds the wait: on the deadline the child is
  killed, and the result carries `timedOut` along with whatever it wrote
  first.
  - The kill reaches the child, not a process group. A child that
    forked a grandchild of its own can leave that grandchild holding
    the output pipes open; the host waits two seconds for them to
    close, then reports the timeout with the output withheld rather
    than blocking. `sh -c 'a; exec b'` avoids this by leaving one
    process to kill.
- Handles are opaque host references — the guest GC owns their
  lifetime; there is nothing to close.

## Implementation notes

The host side lives in `packages/zena-runtime/src/process.rs`. Strings
cross the boundary through the `$stringCreate` / `$stringSetByte` /
`$stringGetByte` / `$stringGetLength` helpers every compiled Zena
module exports; handles cross as `externref`s wrapping host state.
Consumers in-repo: zb, which runs build commands, and `zena:bench`'s
`runSuite`, which runs command variants.
Running another Wasm module is `zena:wasm`'s job.
