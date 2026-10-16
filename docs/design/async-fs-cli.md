# Asynchronous `zena:fs` and `zena:cli`

## Status

Implemented 2026-10-16 (elematic/zena#282). `zena:fs` and `zena:cli`
export asynchronous functions, and the synchronous forms that existed
before carry a `Sync` suffix. The compiler's own file reads stay
synchronous behind `CompilerHost`; see "Migration".

## Overview

`zena:fs` and `zena:cli` sit on WASI 0.3, whose file and standard-input
operations are asynchronous: every method of `wasi:filesystem`'s
`descriptor` is an `async func`, and a file's contents arrive as a
`stream<u8>`. When the two libraries moved to 0.3 (2026-09-28) they kept
the synchronous API they had, and each function waited for its host
call in `blockOn` (`packages/stdlib/zena/wasi/block.zena`): one
`waitable-set.wait` at a time on the running task's set, each event
dispatched the way the component's callback would dispatch it.

That had three costs:

- A synchronous WIT export could not use `zena:fs` at all. wasmtime
  allows a blocking wait only inside a call to an export the host lifted
  `async` ("cannot block a synchronous task before returning"), so a
  `func` export that read a file trapped.
- A file read in a module initializer, or while a test suite
  registered its tests, trapped for the same reason: initializers run
  in the core module's start function, before any task exists.
- A program that read a file blocked the whole component while it
  waited, so nothing else in it, timers included, made progress.

The asynchronous forms are the API now, and the synchronous forms keep
working under a `Sync` suffix, the way Node names `readFileSync` beside
`readFile`.

## The API

### `zena:fs`

Every function that reaches the host returns a future:

```zena
readFile(path): Future<String>
readFileBytes(path): Future<FixedArray<u8>>
writeFile(path, content: String): Future<void>
writeFileBytes(path, content: FixedArray<u8>): Future<void>
listDir(path): Future<Array<DirEntry>>
exists(path), isFile(path), isDirectory(path): Future<boolean>
stat(path): Future<FileStat>
mkdir(path), unlink(path), rmdir(path): Future<void>
rename(from, to): Future<void>
glob(pattern, options?): Future<Array<String>>
```

Each has a `Sync` twin with the same parameters and the awaited type as
its result: `readFileSync(path): String`, `existsSync(path): boolean`,
and so on. A `Sync` form is exactly `blockOn` of the asynchronous one.

`Descriptor`, the open file or directory, has asynchronous methods only
(`readString`, `readAllBytes`, `readStream`, `writeString`,
`writeBytes`, `openAt`, `createAt`, `openDirAt`, `stat`, `statAt`,
`readDir`, `mkdirAt`, `unlinkAt`, `rmdirAt`, `renameAt`). Node's
`fs/promises` draws the same line: the convenience functions come in
both forms, the handle in one. A caller that wants a synchronous
descriptor operation writes `blockOn(file.readString())`.

`getPreopens` and `getRootDir` stay synchronous. They call
`wasi:filesystem/preopens`'s `get-directories`, which is a synchronous
WIT function, so there is nothing to wait for.

`resolvePreopen(path): (Descriptor, String)` is exported: the preopen a
path falls under and the path relative to it, which `zena:http`'s static
file server needs for the same reason the convenience functions do.

Bytes are `FixedArray<u8>`, the type `zena:stream`, `String.toBytes`
and the WIT `list<u8>` mapping use. The previous API dealt in
`ByteArray` and copied between the two at every call; the copies are
gone, and a caller that needs a `ByteArray` for `sha256` or
`ByteBuffer` casts, as `zena:core` itself does: the two are the same
wasm array type.

### `zena:cli`

`readStdin(max?: i32): Future<String>` and `readStdinSync`. `stdin()`
already returned a `Stream<u8>` and is unchanged.

### `zena:console`

Stays synchronous. A print must complete before the next statement runs
so that output is ordered with the program, and the host takes a line
of stdout without blocking in every case but a full pipe, so the
blocking write in `writeStringBlocking` rarely blocks at all. An
asynchronous form would make every log line an `await` for no gain in
the common case. If a program needs non-blocking output, `stdout`'s
`write-via-stream` is reachable through `zena:wasi`'s `lowerByteStream`
with a `Stream<u8>` of its own.

## What the `Sync` forms do where blocking is not allowed

`blockOn` needs a task the host lifted `async`. The compiler exports
`main` async for any program that can reach a blocking wait, so inside
`main`, inside anything `main` calls, and inside a test body the `Sync`
forms work on every host. Three places are outside any such task:

- a synchronous WIT export of a declared world (`greet: func`), which
  the host calls synchronously;
- a module initializer, which runs in the core module's start function;
- test registration: the `suite` callback that calls `test`, which runs
  while the test module initializes.

A `Sync` call there traps in wasmtime with "cannot block a synchronous
task before returning", as it did before this change. The asynchronous
forms work in the first case (an `async func` export, or an async body
the export's wrapper drives) and are the fix for the other two: move
the read into `main` or into the test body and `await` it. The guest
cannot detect the condition ahead of the trap: the canonical ABI has no
builtin that says whether the running task may block, so the `Sync`
forms do not try. The library headers say where they work.

## Migration

The synchronous callers in the repository use the `Sync` forms. They
are the tools, and all of them run from a synchronous `main`: the
compiler's `CompilerHost.readFile` and `listDir`, the test runners, the
`zena` command, `zb`, `zenadoc`, and the test and benchmark harnesses.
Callers already inside an asynchronous function use the asynchronous
forms: `zena:http`'s static file server, whose private copies of the
preopen lookup and `stat` helpers are replaced by `zena:fs`'s, and the
component fixtures that exercise the asynchronous path.

`CompilerHost.readFile` stays synchronous. Making it asynchronous makes
the whole library loader asynchronous, which is a change to the
compiler's shape rather than to the library, and belongs with the
longer-term direction: a fully asynchronous compiler, with parsing and
scope analysis in workers. This change is the first step of that; the
library the compiler would await already exists.

## Related

- [filesystem.md](./filesystem.md): the `zena:fs` API and its history.
- [cli.md](./cli.md): the `zena:cli` API.
- [component-emission.md](./component-emission.md), "When `main` is
  lifted async": why a blocking wait needs an async task.
- [async.md](./async.md): the `Parker` hook `blockOn` is built on.
