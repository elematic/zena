# Filesystem Support Design

## Overview

This document describes Zena's filesystem abstraction, targeting **WASI 0.2**
(Preview 2) for compatibility with wasmtime and other WASI-compliant runtimes.
This is a key step toward a self-hosted compiler.

## Goals

1. **Read files**: Read source files for compilation
2. **Write files**: Write compiled WASM output
3. **Directory traversal**: List source files in a project
4. **wasmtime compatibility**: Run directly with `wasmtime run --dir`
5. **Testability**: Mock filesystem for unit tests in Node.js

## WASI 0.2 Filesystem Interfaces

WASI 0.2 provides filesystem access through these WIT interfaces:

```wit
package wasi:filesystem@0.2.x;

interface preopens {
  use types.{descriptor};
  get-directories: func() -> list<tuple<descriptor, string>>;
}

interface types {
  resource descriptor {
    read-via-stream: func(offset: filesize) -> result<input-stream, error-code>;
    write-via-stream: func(offset: filesize) -> result<output-stream, error-code>;
    read: func(length: filesize, offset: filesize) -> result<tuple<list<u8>, bool>, error-code>;
    write: func(buffer: list<u8>, offset: filesize) -> result<filesize, error-code>;
    open-at: func(path-flags, path: string, open-flags, flags) -> result<descriptor, error-code>;
    read-directory: func() -> result<directory-entry-stream, error-code>;
    stat: func() -> result<descriptor-stat, error-code>;
    create-directory-at: func(path: string) -> result<_, error-code>;
    unlink-file-at: func(path: string) -> result<_, error-code>;
    // ... more methods
  }

  resource directory-entry-stream {
    read-directory-entry: func() -> result<option<directory-entry>, error-code>;
  }

  type filesize = u64;

  record directory-entry {
    type: descriptor-type,
    name: string,
  }

  enum descriptor-type {
    unknown, block-device, character-device, directory, fifo,
    symbolic-link, regular-file, socket
  }

  enum error-code {
    access, would-block, already, bad-descriptor, busy, deadlock,
    quota, exist, file-too-large, illegal-byte-sequence, in-progress,
    interrupted, invalid, io, is-directory, loop, too-many-links,
    message-size, name-too-long, no-device, no-entry, no-lock,
    insufficient-memory, insufficient-space, not-directory, not-empty,
    not-recoverable, unsupported, no-tty, no-such-device, overflow,
    not-permitted, pipe, read-only, invalid-seek, text-file-busy,
    cross-device
  }
}
```

## WIT to Zena Type Mapping

### Primitives

| WIT Type         | Zena Type | Notes                        |
| ---------------- | --------- | ---------------------------- |
| `u8`, `u16`      | `u32`     | Widened, unsigned operations |
| `u32`            | `u32`     | Direct mapping               |
| `u64` (filesize) | `u64`     | Direct mapping               |
| `s8`, `s16`      | `i32`     | Widened, signed operations   |
| `s32`            | `i32`     | Direct mapping               |
| `s64`            | `i64`     | Direct mapping               |
| `f32`            | `f32`     | Direct mapping               |
| `f64`            | `f64`     | Direct mapping               |
| `bool`           | `boolean` | Direct mapping               |
| `char`           | `i32`     | Unicode code point           |

### Compound Types

| WIT Type       | Zena Type           | Notes                           |
| -------------- | ------------------- | ------------------------------- |
| `string`       | `LinearString`      | Zero-copy view on linear memory |
| `list<u8>`     | `U8Buffer`          | Zero-copy view, see below       |
| `list<T>`      | `LinearBuffer<T>`   | Typed view on linear memory     |
| `result<T, E>` | `Result<T, E>`      | Value type, see below           |
| `option<T>`    | `T \| null`         | Nullable union                  |
| `tuple<A, B>`  | `(A, B)`            | Unboxed tuple (multi-return)    |
| `resource`     | `distinct type` u32 | Newtype wrapper, see below      |
| `enum`         | `enum`              | Untagged enum                   |
| `flags`        | `u32` / `u64`       | Bitfield (unsigned)             |
| `record`       | `type R = {...}`    | Zena record type                |
| `variant`      | `enum` + union      | Tagged union (when needed)      |

### Detailed Type Mappings

#### `list<u8>` → `U8Buffer`

WASI byte arrays map to `U8Buffer` from [linear-memory.md](linear-memory.md):

```zena
// Zero-copy view on linear memory - no GC allocation
let bytes: U8Buffer = wasi_read(fd, 1024);
let firstByte = bytes[0];  // @intrinsic('i32.load8_u')

// Convert to GC ByteArray when needed (copies)
let gcBytes: ByteArray = bytes.toByteArray();
```

For write operations, `U8Buffer.alloc()` creates writable linear memory:

```zena
using buf = U8Buffer.alloc(data.length);
data.copyTo(buf);  // Copy GC ByteArray → linear memory
wasi_write(fd, buf.ptr, buf.length);
```

#### `result<T, E>` → `Result<T, E>` or Exceptions

WASI operations frequently fail (file not found, permission denied). Two options:

**Option A: Value-based `Result<T, E>`** (recommended for expected failures)

```zena
// Standard library Result type
type Result<T, E> = { ok: true, value: T } | { ok: false, error: E };

let openAt = (path: string): Result<Descriptor, FsErrorCode> => { ... };

// Usage with pattern matching
match (openAt("config.json")) {
  case { ok: true, value: fd } => processFile(fd),
  case { ok: false, error: FsErrorCode.NotFound } => useDefaults(),
  case { ok: false, error: e } => throw new FsError(e),
}
```

**Option B: Exceptions** (for unexpected failures)

```zena
// Throws FsError on any failure
let openAtOrThrow = (path: string): Descriptor => { ... };
```

**Guideline**: Use `Result<T, E>` when callers commonly handle both cases
(file existence checks). Use exceptions for truly exceptional conditions
(out of memory, corrupted filesystem).

#### `resource` → Distinct Type

WASI resources (descriptors, streams) are handles that must not be confused
with regular integers:

```zena
// Distinct types prevent accidental mixing
distinct type Descriptor = u32;
distinct type InputStream = u32;
distinct type OutputStream = u32;

let fd: Descriptor = openAt("/file.txt");
let stream: InputStream = readViaStream(fd);

// Type error: can't pass InputStream where Descriptor expected
closeDescriptor(stream);  // ❌ Compile error

// Explicit conversion when needed
let rawHandle: u32 = fd as u32;
```

#### `record` → Zena Record Type

WASI records map directly to Zena's immutable record types:

```zena
// WIT: record directory-entry { type: descriptor-type, name: string }
type DirectoryEntry = {
  entryType: DescriptorType,
  name: string,
};

// WIT: record descriptor-stat { type, size, ... }
type DescriptorStat = {
  fileType: DescriptorType,
  size: u64,
  // ... other fields
};
```

#### `string` → `LinearString`

WASI strings live in linear memory. Use `LinearString` from
[strings.md](strings.md) for zero-copy access:

```zena
// LinearString wraps (ptr, len) in linear memory
let path: LinearString = wasi_readlink(fd);

// Use directly with String methods (virtual dispatch)
if (path.startsWith("/")) { ... }

// Copy to GC heap if needed for long-term storage
let gcPath: GCString = path.toGCString();
```

## Zena API Design

### Result Type

The standard library provides a `Result<T, E>` type for explicit error handling:

```zena
// Standard library Result type (from zena:core)
type Result<T, E> = { ok: true, value: T } | { ok: false, error: E };

// Extension methods (via extension class)
extension class ResultExt<T, E> on Result<T, E> {
  // Unwrap or throw
  unwrap(): T {
    match (this) {
      case { ok: true, value: v } => v,
      case { ok: false, error: e } => throw new Error("unwrap on error"),
    }
  }

  // Unwrap or return default
  unwrapOr(default: T): T {
    match (this) {
      case { ok: true, value: v } => v,
      case { ok: false } => default,
    }
  }

  // Map the success value
  map<U>(f: (v: T) => U): Result<U, E> {
    match (this) {
      case { ok: true, value: v } => { ok: true, value: f(v) },
      case { ok: false, error: e } => { ok: false, error: e },
    }
  }
}
```

### Error Handling

```zena
// Error codes matching WASI 0.2
enum FsErrorCode {
  Access,
  WouldBlock,
  BadDescriptor,
  Exist,
  NotFound,       // no-entry
  IsDirectory,
  NotDirectory,
  NotEmpty,
  ReadOnly,
  InvalidSeek,
  Io,
  // ... others as needed
}

// Exception class for throwing errors (used by high-level API)
class FsError extends Error {
  code: FsErrorCode;

  #new(code: FsErrorCode, path: string) {
    super(`Filesystem error: ${code} for ${path}`);
    this.code = code;
  }
}
```

### Descriptor (File/Directory Handle)

```zena
// Distinct handle types prevent accidental mixing
distinct type DescriptorHandle = u32;
distinct type DirStreamHandle = u32;

// File type enumeration
enum FileType {
  Unknown,
  Directory,
  RegularFile,
  SymbolicLink,
}

// File metadata (immutable record)
type FileStat = {
  fileType: FileType,
  size: u64,
};

// Directory entry (immutable record)
type DirEntry = {
  name: string,
  fileType: FileType,
};

// Core descriptor class wrapping a WASI handle
class Descriptor implements Disposable {
  #handle: DescriptorHandle;

  #new(handle: DescriptorHandle) {
    this.#handle = handle;
  }

  // Read entire file contents as bytes
  readAll(): ByteArray { ... }

  // Read file as string (zero-copy LinearString → GC conversion)
  readString(): string { ... }

  // Write bytes to file
  write(data: ByteArray): void { ... }

  // Write string (UTF-8) to file
  writeString(data: string): void { ... }

  // Open a file/directory relative to this descriptor
  openAt(path: string, flags: OpenFlags): Result<Descriptor, FsErrorCode> { ... }

  // Create a file for writing
  createAt(path: string): Result<Descriptor, FsErrorCode> { ... }

  // Get file/directory metadata
  stat(): Result<FileStat, FsErrorCode> { ... }

  // Get metadata of a path relative to this descriptor
  statAt(path: string): Result<FileStat, FsErrorCode> { ... }

  // List directory contents
  readDir(): Result<Array<DirEntry>, FsErrorCode> { ... }

  // Create a directory
  mkdirAt(path: string): Result<void, FsErrorCode> { ... }

  // Delete a file
  unlinkAt(path: string): Result<void, FsErrorCode> { ... }

  // Delete a directory
  rmdirAt(path: string): Result<void, FsErrorCode> { ... }

  // Dispose the descriptor (release handle)
  dispose(): void {
    __wasi_descriptor_drop(this.#handle as u32);
  }
}

// Flags for openAt
enum OpenFlags {
  Read,
  Write,
  ReadWrite,
  Create,
  Truncate,
}
```

### Preopened Directories

```zena
// Preopen entry: descriptor + mount path
type Preopen = {
  descriptor: Descriptor,
  path: string,
};

// Get preopened directories from the WASI runtime
// wasmtime: `--dir /path/to/files::/alias` provides these
let getPreopens = (): Array<Preopen> => { ... };

// Convenience: Get the first preopen (typically the working directory)
let getRootDir = (): Result<Descriptor, FsErrorCode> => {
  let preopens = getPreopens();
  if (preopens.length == 0) {
    return { ok: false, error: FsErrorCode.NotFound };
  }
  return { ok: true, value: preopens[0].descriptor };
};
```

### High-Level API

```zena
// Convenience functions using the root preopen
// These throw on error for simpler usage patterns

let readFile = (path: string): string => {
  using root = getRootDir().unwrap();
  using file = root.openAt(path, OpenFlags.Read).unwrap();
  return file.readString();
};

let writeFile = (path: string, content: string): void => {
  using root = getRootDir().unwrap();
  using file = root.createAt(path).unwrap();
  file.writeString(content);
};

let listDir = (path: string): Array<DirEntry> => {
  using root = getRootDir().unwrap();
  using dir = root.openAt(path, OpenFlags.Read).unwrap();
  return dir.readDir().unwrap();
};

let exists = (path: string): boolean => {
  match (getRootDir()) {
    case { ok: false } => false,
    case { ok: true, value: root } => {
      using r = root;
      match (r.statAt(path)) {
        case { ok: true } => true,
        case { ok: false, error: FsErrorCode.NotFound } => false,
        case { ok: false, error: e } => throw new FsError(e, path),
      }
    }
  }
};
```

## Low-Level WASI Bindings

These are the raw imports from WASI 0.2. The high-level API wraps these.

```zena
// === wasi:filesystem/preopens ===
@external("wasi:filesystem/preopens", "get-directories")
declare function __wasi_get_directories(): i32;  // Returns list handle

// === wasi:filesystem/types - resource lifecycle ===
@external("wasi:filesystem/types", "[resource-drop]descriptor")
declare function __wasi_descriptor_drop(handle: u32): void;

// === wasi:filesystem/types - descriptor methods ===

// open-at: open a file relative to a directory descriptor
@external("wasi:filesystem/types", "[method]descriptor.open-at")
declare function __wasi_descriptor_open_at(
  handle: u32,      // descriptor handle
  pathFlags: i32,   // path-flags
  pathPtr: i32,     // path pointer in linear memory
  pathLen: i32,     // path length
  openFlags: i32,   // open-flags
  descFlags: i32    // descriptor-flags
): i64;  // Returns result<descriptor, error-code> encoded as (ok: u32, value/error: u32)

// read: read bytes from a file
@external("wasi:filesystem/types", "[method]descriptor.read")
declare function __wasi_descriptor_read(
  handle: u32,
  length: u64,      // max bytes to read
  offset: u64       // file offset
): i64;  // Returns result<(list<u8>, bool), error-code>

// write: write bytes to a file
@external("wasi:filesystem/types", "[method]descriptor.write")
declare function __wasi_descriptor_write(
  handle: u32,
  bufferPtr: i32,   // data pointer in linear memory
  bufferLen: i32,   // data length
  offset: u64       // file offset
): i64;  // Returns result<filesize, error-code>

// stat: get file metadata
@external("wasi:filesystem/types", "[method]descriptor.stat")
declare function __wasi_descriptor_stat(handle: u32): i64;

// read-directory: get directory entry stream
@external("wasi:filesystem/types", "[method]descriptor.read-directory")
declare function __wasi_descriptor_read_directory(handle: u32): i64;

// create-directory-at
@external("wasi:filesystem/types", "[method]descriptor.create-directory-at")
declare function __wasi_descriptor_create_directory_at(
  handle: u32,
  pathPtr: i32,
  pathLen: i32
): i32;  // Returns result<_, error-code>

// unlink-file-at
@external("wasi:filesystem/types", "[method]descriptor.unlink-file-at")
declare function __wasi_descriptor_unlink_file_at(
  handle: u32,
  pathPtr: i32,
  pathLen: i32
): i32;  // Returns result<_, error-code>

// === wasi:filesystem/types - directory-entry-stream ===
@external("wasi:filesystem/types", "[method]directory-entry-stream.read-directory-entry")
declare function __wasi_dir_stream_read_entry(handle: u32): i64;

@external("wasi:filesystem/types", "[resource-drop]directory-entry-stream")
declare function __wasi_dir_stream_drop(handle: u32): void;
```

## Memory Management

WASI 0.2 uses **linear memory** for passing strings and byte arrays. Zena uses
WASM-GC, so we need a bridge. See [linear-memory.md](linear-memory.md) for the
full design.

### The `using` Declaration

Linear memory buffers must be explicitly freed. The `using` declaration
provides automatic cleanup:

```zena
func readFile(path: string): ByteArray {
  using pathBuf = path.toLinearString();     // Allocates linear memory
  using dataBuf = U8Buffer.alloc(4096);      // Allocates linear memory

  let bytesRead = wasi_read(fd, dataBuf.ptr, dataBuf.length);
  return dataBuf.slice(0, bytesRead).toByteArray();  // Copy to GC
}  // pathBuf and dataBuf automatically disposed (freed)
```

Without `using`, linear memory would leak:

```zena
// BAD: Linear memory leaked!
func leakyRead(): ByteArray {
  let buf = U8Buffer.alloc(4096);
  let data = wasi_read(fd, buf);
  return data.toByteArray();
  // buf goes out of scope, GC frees the U8Buffer object
  // BUT: 4096 bytes of linear memory are leaked!
}
```

### Zero-Copy String Pipeline

For WASI string I/O, `LinearString` avoids copying:

```zena
// Reading: WASI → LinearString → use directly
let filename: LinearString = wasi_readdir_entry_name();
if (filename.endsWith(".zena")) {
  processFile(filename);
}

// Writing: GCString → LinearString → WASI
func writeLog(msg: string): void {
  using linear = msg.toLinearString();  // Copy GC → linear
  wasi_write(logFd, linear.ptr, linear.length);
}  // linear memory freed
```

### Arena Pattern for Batch Operations

For operations that allocate many buffers with shared lifetime:

```zena
func processDirectory(path: string): void {
  using arena = new Arena();

  // All buffers allocated from arena
  let pathBuf = U8Buffer.alloc(256, arena);
  let entries = Array<DirectoryEntry>.new();

  // ... read directory, process files ...

  // Copy results to GC before arena dies
  let result = entries.map(e => e.name.toGCString());
}  // arena.dispose() frees ALL linear memory at once
```

### Resource Handles

WASI resources are u32 handles wrapped in distinct types. The `Descriptor`
class manages the underlying handle:

```zena
distinct type DescriptorHandle = u32;

class Descriptor implements Disposable {
  #handle: DescriptorHandle;

  dispose(): void {
    wasi_descriptor_drop(this.#handle as u32);
  }
}

// Usage with using declaration
func copyFile(src: string, dst: string): void {
  using srcFd = openAt(src, OpenFlags.Read);
  using dstFd = createAt(dst);

  let data = srcFd.readAll();
  dstFd.writeAll(data);
}  // Both descriptors automatically closed
```

## Implementation Plan

### Phase 1: Basic File I/O

1. **Preopens**: Implement `getPreopens()` to get root directories
2. **Read file**: `openAt` + `read` + string conversion
3. **Write file**: String → linear memory + `write`
4. **Test**: Read a source file in wasmtime

### Phase 2: Directory Operations

1. **stat/statAt**: Get file metadata
2. **readDir**: List directory contents
3. **mkdir/rmdir**: Create/remove directories
4. **unlink**: Delete files

### Phase 3: Streaming (Optional)

1. **read-via-stream**: Streaming reads for large files
2. **write-via-stream**: Streaming writes
3. **Buffered I/O**: Higher-level buffered reader/writer

## Testing Strategy

### Node.js Tests

Use `@bytecodealliance/preview2-shim` with a mock filesystem:

```typescript
// wasi_fs_test_utils.ts
export function createWasiFsImports(mockFs: Map<string, Uint8Array>) {
  const descriptors = new Map<number, MockDescriptor>();
  let nextHandle = 3; // 0=stdin, 1=stdout, 2=stderr

  // Preopen the mock root
  descriptors.set(3, new MockDirDescriptor('/', mockFs));

  return {
    'wasi:filesystem/preopens': {
      'get-directories': () => {
        // Return list of (handle, path) tuples
        return [[3, '/']];
      },
    },
    'wasi:filesystem/types': {
      '[method]descriptor.open-at': (
        handle,
        pathFlags,
        pathPtr,
        pathLen,
        openFlags,
        descFlags,
      ) => {
        // Look up path in mockFs, create new handle
      },
      '[method]descriptor.read': (handle, length, offset) => {
        // Return bytes from mockFs
      },
      // ... other methods
    },
  };
}
```

### wasmtime Integration Tests

```bash
# Create test directory
mkdir -p /tmp/zena-test
echo "Hello, Zena!" > /tmp/zena-test/hello.txt

# Build and run
zena build examples/read-file.zena --target wasi -o /tmp/test.wasm
wasmtime run -W gc=y -W exceptions=y --dir /tmp/zena-test::/ /tmp/test.wasm
```

## Usage Example

```zena
// examples/read-file.zena
import { readFile, writeFile, listDir, getRootDir, OpenFlags } from 'zena:fs';
import { console } from 'zena:console-wasi';

export let main = (): i32 => {
  // Simple API: readFile throws on error
  let content = readFile("hello.txt");
  console.log("File contents:");
  console.log(content);

  // Result API: explicit error handling
  match (getRootDir()) {
    case { ok: false, error: e } => {
      console.log("No preopened directories");
      return 1;
    },
    case { ok: true, value: root } => {
      using r = root;

      // List directory with explicit error handling
      match (r.openAt(".", OpenFlags.Read)) {
        case { ok: false, error: e } => {
          console.log("Failed to open directory");
          return 1;
        },
        case { ok: true, value: dir } => {
          using d = dir;
          match (d.readDir()) {
            case { ok: true, value: entries } => {
              console.log("Directory listing:");
              for (var i = 0; i < entries.length; i = i + 1) {
                console.log(entries[i].name);
              }
            },
            case { ok: false } => {
              console.log("Failed to read directory");
            },
          }
        },
      }
    },
  }

  return 0;
};
```

Running with wasmtime:

```bash
wasmtime run -W gc=y -W exceptions=y \
  --dir ./examples::/examples \
  read-file.wasm
```

## Relation to Other Documents

- **[linear-memory.md](linear-memory.md)**: Buffer classes, `using` declaration,
  arena pattern - the foundation for WASI I/O
- **[strings.md](strings.md)**: `LinearString` design for zero-copy WASI strings
- **[console-wasi-strategy.md](console-wasi-strategy.md)**: WASI console I/O
  strategy
- **[wasi.md](wasi.md)**: General WASI support overview
- **[host-interop.md](host-interop.md)**: Host/WASM type marshalling

## Future Considerations

### Component Model GC

When `component-model-gc` stabilizes in wasmtime, we may be able to pass GC
strings directly without copying to linear memory. This would simplify the
implementation significantly.

### Path API

Consider a `Path` abstraction for path manipulation:

```zena
class Path {
  #parts: Array<string>;

  static parse(s: string): Path { ... }
  join(other: Path): Path { ... }
  parent(): Path | null { ... }
  filename(): string { ... }
  extension(): string | null { ... }
  toString(): string { ... }
}
```

### Async I/O (WASI Preview 3)

When WASI Preview 3 stabilizes with async support, add async file operations:

```zena
// Future API
let readFileAsync = async (path: string): Promise<string> => { ... };
```
