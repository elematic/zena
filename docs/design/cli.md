# CLI Standard Library Design

## Overview

The `zena:cli` module provides command-line interface utilities for Zena
programs, including:

- Command-line argument access
- Environment variable access
- Process exit control
- Argument parsing utilities

## Design Philosophy

### WASI P2 API Compatibility

The API is designed to closely mirror **WASI Preview 2**'s CLI interfaces, even
though the current implementation uses WASI Preview 1. This provides:

1. **Easy migration path** - When Zena moves to WASI P2, the API stays the same
2. **Familiar interface** - Developers familiar with WASI will recognize the API
3. **Consistency** - Similar approach to other Zena stdlib modules (fs, console)

### Interface Mapping

| Zena API              | WASI P2 Interface                        | WASI P1 Implementation          |
| --------------------- | ---------------------------------------- | ------------------------------- |
| `getArguments()`      | `wasi:cli/environment.get-arguments`     | `args_sizes_get`, `args_get`    |
| `getEnvironment()`    | `wasi:cli/environment.get-environment`   | `environ_sizes_get`, `environ_get` |
| `getEnv(name)`        | (convenience wrapper)                    | (uses `getEnvironment`)         |
| `initialCwd()`        | `wasi:cli/environment.initial-cwd`       | `getEnv("PWD")` fallback        |
| `exit(code)`          | `wasi:cli/exit.exit-with-code`           | `proc_exit`                     |
| `exitSuccess()`       | `wasi:cli/exit.exit` (Ok)                | `proc_exit(0)`                  |
| `exitFailure()`       | `wasi:cli/exit.exit` (Err)               | `proc_exit(1)`                  |

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
let getEnv = (name: string): string?
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
let getArguments = (): Array<string>

// Get just the program name
let getProgramName = (): string
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
let isOption = (arg: string): bool       // starts with -
let isShortOption = (arg: string): bool  // -x format
let isLongOption = (arg: string): bool   // --name format

// Parse long option with value
let parseLongOption = (arg: string): ParsedOption

type ParsedOption = {
  name: string,
  value: string?,
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

### Memory Management

The CLI functions use WASI Preview 1, which requires linear memory for passing
data. The implementation:

1. Allocates temporary buffers using `zena:memory.defaultAllocator`
2. Calls WASI functions to populate the buffers
3. Converts C-strings to Zena strings
4. Frees the temporary buffers

This is similar to how `zena:fs` handles WASI I/O.

### String Handling

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

Reading from stdin is available via WASI P1's `fd_read` on fd 0. This may be
exposed via:

```zena
// Option 1: Add to zena:cli
let readLine = (): string?

// Option 2: Integrate with zena:io streams
import { stdin } from 'zena:io';
let line = stdin.readLine();
```

## WASI P2 Migration Path

When Zena adopts WASI Component Model (Preview 2):

1. **No API changes needed** - The Zena API already mirrors P2
2. **Implementation swap** - Replace P1 calls with P2 component imports
3. **Better error handling** - P2 uses `result` types which map to Zena's
   error handling

The P2 implementation would look like:

```zena
// Future P2 implementation (conceptual)
@import("wasi:cli/environment", "get-arguments")
declare function __wasi_get_arguments(): Array<string>;

export let getArguments = (): Array<string> => {
  return __wasi_get_arguments();  // Direct, no marshalling needed with CM-GC
};
```

## References

- [WASI CLI Proposal](https://github.com/WebAssembly/WASI/tree/main/proposals/cli)
- [WASI Preview 1 API](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md)
- [WASI Preview 2 Overview](https://github.com/WebAssembly/WASI/blob/main/docs/Preview2.md)
