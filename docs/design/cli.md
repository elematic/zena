# CLI Standard Library Design

## Status

Implemented over `wasi:cli@0.3.0`, in `packages/stdlib/zena/cli/component.zena`,
since 2026-09-28: `getArguments`, `getEnvironment` and `initialCwd` call the
modules the compiler synthesizes from the vendored WIT
(`wasi:cli/environment`), and `exit` calls `wasi:cli/exit`'s `exit-with-code`.
The module resolves on the `zena-cli` and `component` targets, which are
both components. The WASI preview 1 implementation this document describes
below, with its linear-memory buffers and C strings, was deleted with the
rest of preview 1; those sections are kept as the record of the first
implementation.

## Overview

The `zena:cli` module provides command-line interface utilities for Zena
programs, including:

- Command-line argument access
- Environment variable access
- Process exit control
- Argument parsing utilities

## Design Philosophy

### WASI P2 API Compatibility

The API was designed to closely mirror **WASI Preview 2**'s CLI interfaces
while the first implementation used WASI Preview 1. That paid off when the
implementation moved to WASI 0.3, whose `wasi:cli` interfaces are the same
functions: the API did not change.

### Interface Mapping

The 0.3 column is what the implementation calls today; the preview 1 column
is what the first implementation called.

| Zena API           | WASI 0.3 Interface                     | WASI P1 Implementation (deleted)   |
| ------------------ | -------------------------------------- | ---------------------------------- |
| `getArguments()`   | `wasi:cli/environment.get-arguments`   | `args_sizes_get`, `args_get`       |
| `getEnvironment()` | `wasi:cli/environment.get-environment` | `environ_sizes_get`, `environ_get` |
| `getEnv(name)`     | (convenience wrapper)                  | (uses `getEnvironment`)            |
| `initialCwd()`     | `wasi:cli/environment.initial-cwd`     | `getEnv("PWD")` fallback           |
| `exit(code)`       | `wasi:cli/exit.exit-with-code`         | `proc_exit`                        |
| `exitSuccess()`    | `wasi:cli/exit.exit` (Ok)              | `proc_exit(0)`                     |
| `exitFailure()`    | `wasi:cli/exit.exit` (Err)             | `proc_exit(1)`                     |

## API Reference

### Exit Codes

```zena
enum ExitCode {
  Success,           // 0 - Successful termination
  Failure,           // 1 - Generic failure
  InvalidArguments,  // 2 - Invalid command-line arguments
  NotFound,          // 3 - Resource not found
  PermissionDenied,  // 4 - Permission denied
  IoError,           // 5 - I/O error
}
```

### Environment Variables

```zena
// Get all environment variables as key-value pairs
let getEnvironment = (): Array<EnvVar>

// Get a single environment variable by name
let getEnv = (name: String): String?
```

**Example:**

```zena
import { getEnvironment, getEnv } from 'zena:cli';

// Get all variables
for (let env in getEnvironment()) {
  console.log(env.name + "=" + env.value);
}

// Get single variable with default
let port = getEnv("PORT") ?? "8080";
```

### Command-Line Arguments

```zena
// Get all command-line arguments
let getArguments = (): Array<String>

// Get just the program name
let getProgramName = (): String
```

**Example:**

```zena
import { getArguments, getProgramName } from 'zena:cli';

let args = getArguments();
console.log("Program: " + getProgramName());
console.log("Args: " + args.length.toString());

// Skip program name, process remaining args
for (var i = 1; i < args.length; i = i + 1) {
  console.log("  " + args[i]);
}
```

### Process Control

```zena
// Exit with specific code (0-255)
let exit = (code: i32): void

// Exit with success (code 0)
let exitSuccess = (): void

// Exit with failure (code 1)
let exitFailure = (): void
```

**Example:**

```zena
import { exit, exitSuccess, exitFailure, ExitCode } from 'zena:cli';

// Check arguments
if (args.length < 2) {
  console.error("Missing required argument");
  exit(ExitCode.InvalidArguments);
}

// Normal completion
exitSuccess();
```

### Argument Parsing Utilities

```zena
// Check option types
let isOption = (arg: String): bool       // starts with -
let isShortOption = (arg: String): bool  // -x format
let isLongOption = (arg: String): bool   // --name format

// Parse long option with value
let parseLongOption = (arg: String): ParsedOption

type ParsedOption = {
  name: String,
  value: String?,
}
```

**Example:**

```zena
import { getArguments, isLongOption, parseLongOption, isOption } from 'zena:cli';

for (let arg in getArguments()) {
  if (isLongOption(arg)) {
    let opt = parseLongOption(arg);
    console.log("Option: " + opt.name);
    if (opt.value != null) {
      console.log("  Value: " + opt.value);
    }
  } else if (!isOption(arg)) {
    console.log("Positional: " + arg);
  }
}
```

## Implementation Details

The 0.3 implementation has no marshaling of its own: the compiler
synthesizes a Zena module per WIT interface, so `get-arguments` arrives as
a function returning `Array<String>` and `exit-with-code` as one taking a
`u8`. Everything below describes the preview 1 implementation, kept as
history.

### Memory Management (preview 1)

The CLI functions used WASI Preview 1, which requires linear memory for
passing data. The implementation:

1. Allocates temporary buffers using `zena:memory.defaultAllocator`
2. Calls WASI functions to populate the buffers
3. Converts C-strings to Zena strings
4. Frees the temporary buffers

This is similar to how `zena:fs` handles WASI I/O.

### String Handling (preview 1)

WASI P1 uses null-terminated C strings in linear memory. The `readCString`
helper:

1. Scans for the null terminator to find length
2. Copies bytes to a GC-allocated `ByteArray`
3. Uses `String.fromByteArray()` to create a Zena string
4. The Zena string lives on the GC heap, independent of linear memory

### Error Handling

Most functions return empty results on error rather than throwing:

- `getArguments()` returns empty array on WASI error
- `getEnvironment()` returns empty array on WASI error
- `getEnv()` returns `null` if variable not found

This matches WASI P2's design where these are always available (just possibly
empty).

## Future Work

### Signal Handling

WASI Preview 2 does not yet standardize signal handling (Ctrl+C, SIGTERM, etc.).
When `wasi:signals` or similar is standardized, we will add:

```zena
// Proposed future API
enum Signal { Interrupt, Terminate, Hangup, ... }
let onSignal = (signal: Signal, handler: () => void): void
```

### Terminal I/O

WASI P2 includes terminal interfaces (`wasi:cli/terminal-input`,
`wasi:cli/terminal-output`) for interactive terminal features:

- Query terminal size
- Detect if connected to a TTY
- Enable raw mode

These will be added when needed, possibly as a separate `zena:terminal` module.

### Stdin Reading

Reading from stdin is available through `wasi:cli/stdin@0.3.0`'s
`read-via-stream`, which hands back a `stream<u8>`. This may be exposed
via:

```zena
// Option 1: Add to zena:cli
let readLine = (): String?

// Option 2: Integrate with zena:io streams
import { stdin } from 'zena:io';
let line = stdin.readLine();
```

## The move to WASI 0.3

Zena skipped Preview 2 and moved from preview 1 to WASI 0.3 in one step
(2026-09-28; see [component-emission.md](./component-emission.md)). As
planned, the API did not change and the implementation was swapped. The
0.3 implementation imports the synthesized interface modules directly:

```zena
import { getArguments as witGetArguments } from 'wasi:cli/environment';

export let getArguments = (): Array<String> => witGetArguments();
```

## References

- [WASI CLI Proposal](https://github.com/WebAssembly/WASI/tree/main/proposals/cli)
- [WASI Preview 1 API](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md)
- [WASI Preview 2 Overview](https://github.com/WebAssembly/WASI/blob/main/docs/Preview2.md)
