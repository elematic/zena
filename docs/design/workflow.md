# Workflow Engine and Build System

Status: **Proposal** (2026-09).

This document plans a family of tools built around one core library:

- **`workflow`** — a Zena library containing the logic of incremental
  workflow execution: steps, dependencies, fingerprints, caching decisions,
  and long-running services. It performs no I/O.
- **`zb`** (working name) — a build system in the style of
  [Wireit](https://github.com/google/wireit), built on `workflow`. It adds
  files, globs, process spawning, watching, and pluggable caches, and
  extends Wireit with rule abstractions and fine-grained input-to-output
  tracking.
- **Rules** — parameterized step generators (a "TypeScript build" rule
  instead of twelve near-identical script stanzas), eventually loadable as
  sandboxed WASI components.
- **Other hosts** — the same core library reused by the static site
  generator described in [declarative.md](declarative.md), a durable
  cloud workflow runner, and a persistent-compiler integration for Zena
  itself.

## Background

The Zena monorepo builds with Wireit today. Wireit's model is small and
good: npm scripts annotated with dependencies, input files, and output
files; a script reruns only when the fingerprint of its inputs changes;
outputs can be cached and restored; *services* are scripts that stay
running, signal readiness, and shut down when their last dependent
finishes.

Three problems motivate a successor:

1. **No abstraction.** Every TypeScript package in the monorepo repeats
   the same stanza: the `tsc` command, `src/**/*.ts` plus `tsconfig.json`
   in `files`, the emitted globs in `output`, `"clean": "if-file-deleted"`.
   Each copy is a chance to forget the tsconfig or mis-glob the outputs,
   and fixing a convention means editing every package.
2. **Coarse invalidation.** A script's outputs are invalidated as a unit.
   A one-page edit to a documentation site rebuilds every page. Wireit
   issue [#168](https://github.com/google/wireit/issues/168) asks for the
   changed/added/removed file lists to be exposed to scripts; this design
   goes further and tracks which outputs depend on which inputs.
3. **The logic is not reusable.** The scheduling, fingerprinting, and
   service-lifecycle logic is welded to npm, package.json, and the local
   filesystem. The same logic is needed by a static site generator, a
   database-backed durable workflow runner, and potentially the compiler —
   each with different I/O.

The layering below exists to solve problem 3 first: get the logic right
once, in a library that any host can drive.

## Layering

```
┌─────────────────────────────────────────────────────────────┐
│ Hosts                                                       │
│   zb (build CLI)   site generator   durable runner   tests  │
├──────────────────────────────┬──────────────────────────────┤
│ Rules (zb only)              │  Host adapters               │
│   builtin: typescript, zena  │   fs hashing, globs,         │
│   later: WASI components     │   process spawn, watchers,   │
│                              │   cache backends, DB state   │
├──────────────────────────────┴──────────────────────────────┤
│ workflow (core library, no I/O)                             │
│   step graph · fingerprints · cache keys · scheduling ·     │
│   services · per-output invalidation · resumable state      │
└─────────────────────────────────────────────────────────────┘
```

The core library never opens a file, spawns a process, hashes bytes, or
talks to a network. Hosts hand it fingerprints and callbacks; it hands
back decisions and, through the callbacks, drives execution.

## Core library

Package `workflow`, registered in `zena-packages.json` like `wit-parser`.

### Model

- **Fingerprint** — an opaque digest string produced by the host
  (typically a content hash of a file, or a digest of configuration).
  The library compares fingerprints for equality and combines them into
  cache keys; it never computes one from raw bytes.
- **Input** — a named leaf value with a fingerprint. For the build system
  a leaf is a file; for the durable runner it is a database row; the
  library does not know or care.
- **Step** — a node in the dependency graph. A step has:
  - a stable **key** (its identity across runs),
  - a **config fingerprint** covering everything that affects its behavior
    other than its inputs (the command line, rule parameters, rule
    version),
  - **input references**: leaf inputs and other steps' outputs,
  - a **run callback**, supplied by the host, that performs the actual
    work and returns an output manifest.
- **Output manifest** — the step's result: a list of named outputs, each
  with a fingerprint, plus optional per-output dependency records (see
  fine-grained tracking below). Manifests are plain data and serializable.
- **Service** — a step variant whose callback resolves not on completion
  but on *readiness*, returning a handle with a `stop` operation.

### Host interface

The host supplies capabilities as small interfaces and callbacks rather
than one filesystem-shaped object:

```zena
/** Maps a cache key to a previously recorded output manifest. */
interface StepCache {
  get(key: CacheKey): Future<OutputManifest?>;
  put(key: CacheKey, manifest: OutputManifest): Future<void>;
}

/** What a task step's callback receives. */
class RunContext {
  /** Changed/added/removed inputs since the last recorded run,
      or null when no usable history exists (run from scratch). */
  delta: InputDelta?;
  /** The manifest of the last recorded run, when delta is non-null. */
  previous: OutputManifest?;
  /** Cancellation and progress reporting. */
  // ...
}
```

Restoring cached output *bytes* (e.g. copying files out of a cache
directory) is the host's business: `StepCache.get` returning a manifest
means "this result exists and is restorable"; the engine then asks the
host to materialize it only when a dependent actually needs it. Hosts
that store blobs split storage Bazel-style into an action cache
(cache key → manifest) and a content-addressed blob store
(fingerprint → bytes); the library only sees the first half.

### Cache keys

A step's cache key is a digest of its config fingerprint plus the sorted
(name, fingerprint) pairs of its resolved inputs, computed with a
canonical serialization defined by the library. Transitivity falls out:
a step's inputs include its dependencies' output fingerprints, so a
change anywhere upstream changes the key. This is the same scheme Wireit
uses, made explicit as a datatype.

### Execution

`Engine.run` takes the step graph, the previous run's state, and the
host capabilities; it schedules steps in dependency order with bounded
parallelism on a `TaskGroup`, consults the cache before running anything,
and returns a result carrying the new state. Cancellation uses the
standard `CancelScope` machinery: cancelling the run cancels in-flight
callbacks and stops services in reverse dependency order. Failure policy
(fail fast vs. build as much as possible) is a run option.

The engine is deterministic given the host's responses. That is what
makes the durable runner possible: persist every host interaction's
result, and a crashed run can be resumed by replaying them into a fresh
engine, which will make the same decisions and continue where it left
off.

### Services

Service semantics follow Wireit:

- A service starts when the first step that depends on it is ready to
  run, after the service's own dependencies are ready.
- Dependents wait for the ready signal, not termination.
- The engine stops a service (via its handle) when its last dependent
  finishes; in watch mode the host can pin services alive across runs.
- A service's fingerprint participates in cache keys like any step's, and
  a fingerprint change in watch mode restarts the service.

Service handles are resources: `stop` is `:dispose`, so ownership
tracking guarantees the engine cannot leak a running service.

### Fine-grained input-to-output tracking

The unit of caching above is the step. To rebuild one page of a
thousand-page site, the step's callback additionally reports, per output,
which inputs it depended on:

```zena
class OutputRecord {
  name: String;              // 'out/docs/getting-started.html'
  fingerprint: Fingerprint;
  dependsOn: Array<String>?; // input names; null = all inputs
}
```

On the next run, if the step's config fingerprint is unchanged, the
engine intersects the input delta with these records and passes the
callback a `delta` listing exactly which inputs changed and which prior
outputs are stale. The callback may then regenerate only those outputs,
returning a manifest that merges fresh records with carried-over ones.
The engine verifies the merge covers every output.

Correctness rules:

- Dependency records are advisory *observations by the step itself*
  (like compiler depfiles). A step that reports wrong records gets wrong
  incremental builds — same trust model as Wireit's `files` globs, and
  same remedy: a paranoid mode that also runs from scratch and compares
  manifests.
- Records are only consulted when the config fingerprint matches the
  recording run. A rule upgrade invalidates everything, no exceptions.
- The whole-step cache key is unchanged by this feature; fine-grained
  state only accelerates the *miss* path.

This subsumes Wireit issue #168: a host that just wants the changed-file
list gets it from `delta` without recording any per-output data.

### Non-goals for the core library

File watching, glob expansion, content hashing, process management,
persistence, and network transfer all belong to hosts. The library also
does not define a configuration format; graphs are constructed
programmatically by whatever reads the host's config.

[choreography.md](choreography.md) covers a different problem —
multi-party protocols projected onto independent services — and is not
layered on this library, though a choreography runtime could use one
engine per participant.

## Build system

A CLI, working name `zb`, that reads a workspace's build configuration,
constructs a step graph, and drives the engine with filesystem adapters:

- **Inputs**: glob expansion and content hashing produce the leaf
  fingerprints. Hashes are memoized by (path, mtime, size) as Wireit does.
- **Execution**: commands spawn via `zena:process`
  ([#112](https://code.rictic.com/justin/zena/issues/112)); services get
  ready checks (port open, stdout line match, or an explicit protocol).
- **State**: the engine's state and the local cache live under `.zb/`.
- **Cleaning**: because the previous manifest lists outputs exactly, `zb`
  deletes stale outputs precisely instead of Wireit's
  `clean: "if-file-deleted"` heuristic.
- **Watch mode**: a watcher feeds leaf invalidations to repeated engine
  runs; services stay pinned between runs (see file watching below).
- **Delta to commands**: for scripts that can use it, the input delta is
  exposed as files of newline-separated paths named by environment
  variables (`ZB_CHANGED_FILES`, `ZB_REMOVED_FILES`), per the stdin/env
  designs discussed in Wireit #168.

### Configuration

Configuration uses `build.zconf`, the pure-declarative Zena format from
[declarative.md](declarative.md) — statically parseable data with no
logic. A converter imports existing `package.json` wireit stanzas, and a
compatibility reader lets `zb` run an unconverted Wireit workspace so the
monorepo can migrate incrementally and A/B the two systems.

```zconf
scripts: {
  'build:cli': {
    command: 'zena-cli build zena/cli/main.zena -o zena/out/cli.wasm',
    files: ['zena/**/*.zena', 'bootstrap/cli.wasm'],
    output: ['zena/out/cli.wasm'],
    dependencies: ['../zena-cli:build'],
  },
  'build:scripts': typescript({tsconfig: 'tsconfig.json'}),
}
```

### Configuration compilation

Parsing configuration and expanding rules on every invocation spends
startup time exactly where latency is most visible: the warm no-op
build. Because `build.zconf` is statically parseable Zena data and rules
are Zena functions, a workspace's configuration can be compiled instead
of interpreted: `zb` generates the graph-construction code with rules
already expanded, compiles it against the `workflow` library, and caches
the precompiled binary keyed by the fingerprints of the config files and
recorded rule reads. A warm invocation then starts a program whose graph
is a constant, and goes straight to fingerprint checks. The recorded
config reads make invalidation exact: editing any tsconfig a rule looked
at recompiles the configuration.

A cheaper variant with most of the benefit is a binary snapshot: the
constructed graph serialized once and loaded without parsing or rule
expansion. Snapshots need no compiler at invalidation time, so they are
the likely first implementation, with true compilation as an upgrade
that also inlines rule executors.

A Google-sized monorepo cannot bundle its graph into one program either
way. The same machinery applies piecewise: configuration compiles or
snapshots per package or per directory subtree, and `zb` loads only the
units reachable from the requested targets. Nothing in the engine
requires the whole graph up front — steps are keyed, so the host can
materialize just the reachable subgraph before a run.

### File watching

WASI provides no change-notification API — `wasi:filesystem` can read
and stat but not watch — so watching is a host capability: `zena-cli`
exposes the platform watchers (inotify, FSEvents, kqueue, via a crate
such as `notify`) to Zena as an import, the same pattern as
`zena:process`. Where native watching is unavailable, the fallback is
polling: re-stat the input set on an interval and re-hash only entries
whose (mtime, size) memo misses. Both producers emit the same leaf
invalidation events, and the engine is unaware of the difference.

### Pluggable caches

The cache is two host interfaces: the action cache (key → manifest) and
a blob store (fingerprint → bytes). Backends compose — check local, then
remote; write through to both. Planned backends: local directory, GitHub
Actions cache, and a plain HTTP server for a self-hosted shared cache.
Remote hits restore only the outputs a dependent actually needs.

## Rules

A rule is a function from parameters to step definitions. The TypeScript
rule above expands to the full stanza: the `tsc` command, the source
globs, `tsconfig.json` *and every file the tsconfig `extends`* in the
inputs, the output globs derived from `outDir`, and incremental-friendly
cleaning — none of it repeated per package, all of it versioned with the
rule.

Reading the tsconfig requires I/O, which is why rules cannot be purely
declarative. A rule runs at graph-construction time with a narrow
context: it may read files it names, and every read is automatically
recorded as an input of the *configuration* itself, so editing a
tsconfig re-expands the rule. This closes the "forgot to list the
tsconfig" class of bug structurally.

Delivery in two phases:

1. **Built-in rules**, written in Zena and compiled into `zb`:
   `typescript`, `zena` (see below), and a generic `script` rule that is
   just the raw stanza. This covers the monorepo.
2. **Rule plugins as WASI components.** A rule component exports the
   expansion function (and optionally an in-process step executor, which
   is how a rule ships fine-grained incremental logic). `zb` instantiates
   it with a read-only preopen of the workspace, no network, no clocks —
   WASI's capability model makes the sandbox the default. This waits on
   dynamic component loading in the Zena runtime; the interface is
   designed now so built-in rules already fit it, making the later cut
   mechanical. Components also make rules language-agnostic: a rule for
   some ecosystem can be written in that ecosystem's language.

## Zena compiler integration

Zena compiles whole programs, so there are no per-library compile steps
to cache. Two integrations matter instead:

- **Filesets.** A `zena_library` rule expands to a step with no command:
  its output manifest is its input manifest. Downstream binaries depend
  on filesets, and the fileset boundary gives the graph its structure
  without pretending there are intermediate artifacts.
- **A compile server.** A persistent compiler is the difference between
  a warm rebuild that reuses parsed stdlib and checked modules and one
  that starts cold. The compiler already has the pieces: the language
  service drives incremental recompilation through the loader's
  `invalidate` path, and batch compilation showed a long-lived instance
  pays for itself when reused (with a bounded lifetime — instances are
  recycled after a number of compiles).

  The server is an ordinary `zb` service. Protocol: newline-delimited
  JSON over stdio initially, with requests `compile` (entry point, output
  path, flags), `invalidate` (changed paths), and `shutdown`; responses
  carry diagnostics, output fingerprints, and the observed file
  dependencies of the compile. Observed dependencies feed straight into
  the fine-grained tracking above. When component support lands, the
  protocol becomes a WIT interface and the stdio framing disappears.

  Caching is unaffected: the build step's cache key is still computed
  from input fingerprints, so a warm server is purely an optimization of
  the miss path, and a server bug can at worst produce a wrong artifact
  that paranoid mode catches — the same guarantee as any other step.

## Durable cloud runner

An existing prototype runs AI-generated workflows as WASI component
steps, persisting each step's outputs to a database and running steps
when their inputs are ready. It maps onto the same engine:

- Steps' run callbacks invoke components; output manifests are rows.
- The action cache is a table; the blob store is object storage.
- The engine's determinism gives resumption: the host journals completed
  manifests, and resuming a run replays the journal into a fresh engine.
- Services map to external resources (a provisioned sandbox, a database
  connection) with readiness and teardown, which the service lifecycle
  already models.

The prototype becomes a host adapter rather than a parallel
implementation, and improvements to the engine (fine-grained
invalidation, cancellation) accrue to it for free.

## Milestones

1. **Core library.** `workflow` package: graph, cache keys, scheduler,
   services, state serialization. Tested entirely with in-memory hosts —
   simulated fingerprints, scripted cache responses, fake clocks — which
   the no-I/O design makes cheap.
2. **`zb` minimum.** Wireit-compatibility reader, task steps, local
   cache, precise cleaning. Run side by side with Wireit on this
   monorepo and diff the decisions.
3. **Services and watch mode.** Parity with the Wireit features the
   monorepo uses; the `zena-cli` watcher capability with the polling
   fallback; `build.zconf` and the converter.
4. **Fine-grained tracking.** Engine delta plumbing, `ZB_CHANGED_FILES`,
   per-output records; prove it on the website build.
5. **Built-in rules.** `typescript`, `zena` filesets, config-read
   recording.
6. **Configuration snapshots.** Serialized graphs keyed by config
   fingerprints; measure warm no-op startup. Compiled configuration
   follows when the measurement justifies it.
7. **Remote caches.** GitHub Actions and HTTP backends; move CI to `zb`.
8. **Compile server.** Protocol in `zena-cli`, service rule in `zb`.
9. **Component rules and the durable runner.** After dynamic component
   loading lands.

Milestones 1–2 are the commitment point; each later milestone is useful
on its own and none blocks the ones before it.

## Alternatives considered

- **Adopting Bazel's model** (actions, providers, remote execution API).
  The action-cache/CAS split is adopted; the rest is oversized for a
  Wireit-shaped tool, and remote *execution* is out of scope entirely.
- **A filesystem interface in the core library.** A `Filesystem` trait
  the engine calls directly would make the build system slightly shorter
  and every other host worse: the durable runner has no filesystem, the
  site generator wants layered virtual sources, and tests want scripted
  responses. Passing fingerprints and callbacks keeps the engine's
  requirements explicit and small.
- **Fully dynamic dependencies** (Ninja dyndeps / Shake-style monadic
  builds), where the graph itself is discovered during execution. More
  expressive, much harder to schedule and to explain. Per-output records
  within a statically-shaped step cover the observed need (issue #168,
  the SSG, compiler depinfo) without giving up a plannable graph.
- **Rules as arbitrary scripts** (Wireit + a config generator). Works
  today, but generation runs outside the build's fingerprint discipline:
  nothing rebuilds when the generator or its inputs change. Rules inside
  the graph get versioning and invalidation for free.
