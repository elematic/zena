---
title: 'Libraries'
description: 'Libraries, source files, imports, exports, packages, and compilation structure in Zena.'
---

In Zena, every `.zena` source file is a **library** with its own top-level
lexical scope. Programs compose libraries through explicit imports and exports.

::: note Terminology: Libraries versus modules
In JavaScript, an individual source file is called a module. Zena uses the term
**library** for source files, reserving **module** exclusively for WebAssembly
modules (`.wasm` binaries).
:::

## Libraries and source files

Source files and libraries have a one-to-one relationship: each file defines an
isolated lexical scope with no implicit globals. Even when two files reside in
the same directory, declarations in one library are not visible in another
unless explicitly exported and imported.

Libraries within the same package reference one another using relative paths:

```zena
import { Config } from './config.zena';
import { Logger } from '../logging/logger.zena';
```

File paths in relative imports are normalized by the compiler. Redundant
segments such as `./` and `../` resolve to a single canonical path for each
library, guaranteeing that a given file is loaded, parsed, and checked only
once during compilation.

## Top-level declarations

A library consists of a sequence of top-level declarations:

- Library variables (`let` and `var`)
- Functions (`function` declarations and arrow variable bindings)
- Nominal classes (`class`, `case class`, `sealed class`)
- Interfaces (`interface`)
- Mixins (`mixin`)
- Enumerations (`enum`)
- Type aliases and distinct types (`type`, `distinct type`)
- Host declarations (`declare function`)
- Imports and exports

Declarations at the top level are private to the library by default. Prepending
the `export` keyword makes a declaration available to other libraries and
packages:

```zena
// Private to this library
let secretKey = "42";

function validateKey(key: String): boolean {
  return key == secretKey;
}

// Exported to other libraries
export let serviceName = "auth-service";

export function authenticate(key: String): boolean {
  return validateKey(key);
}
```

Top-level `function` declarations can never capture local lexical scopes. They
reside at the library level and can access library variables and other top-level
functions directly.

### Variable exports and live bindings

Exported variables can be declared immutable with `let` or mutable with `var`:

```zena
export let appVersion = "1.0.0";
export var requestCount = 0;

export function recordRequest(): void {
  requestCount += 1;
}
```

- **Live bindings**: Named exports are live bindings. When an exporting library
  mutates an exported `var`, any importing library observes the updated value on
  subsequent reads.
- **Read-only to importers**: An imported variable is always read-only in the
  importing library. An importer cannot reassign an imported binding; attempting
  to assign to it is a compile-time error. Only the declaring library can reassign
  its own mutable variables.

## Entry points and main()

An executable Zena program defines an exported entry function named `main`. When
executed by a WebAssembly host or test runner, library initialization runs first,
followed by `main()`.

Like any function, `main` can return `void` or a value:

```zena
export function main(): void {
  console.log("Program started");
}
```

When `main` returns a value, it is returned directly to the host that invoked
it. For example, `zena-cli run` prints non-void return values to standard output:

```zena
export function main(): i32 {
  return 42; // Printed to stdout by zena-cli run
}
```

To terminate a command-line program with an explicit process exit code under WASI
or CLI environments, call `exit()` from the `zena:cli` library rather than returning
from `main`:

```zena
import { exit, ExitCode } from 'zena:cli';

export function main(): void {
  if (!checkPrerequisites()) {
    exit(ExitCode.Failure);
  }
}
```

`main` can also be declared as an exported variable bound to an arrow function:

```zena
export let main = (): i32 => {
  return 0;
};
```

### Async main

An entry function can be declared with `async`, returning a `Future<T>`:

```zena
export async function main(): Future<void> {
  console.log('Starting application...');
  let config = await loadConfig('config.json');
  await runServer(config);
}
```

When `main()` is asynchronous, the runtime enters the event loop and drives the
returned `Future` and its microtasks to completion before host execution ends.

## Imports and exports

Libraries exchange declarations using `import` and `export` statements.

### Named imports

Specific symbols are imported by name within braces:

```zena
import { Map, Set } from 'zena:collections';
import { Point } from './geometry.zena';
```

Imported names can be renamed at the import site using `as`:

```zena
import { StringBuilder as SB } from 'zena:core';

let builder = new SB();
```

Zena also supports the `from ... import` inverted syntax:

```zena
from 'zena:collections' import { Map, Set };
```

Imported variables are read-only in the importing library, but reflect live
updates if the exporting library mutates an exported `var`.

### Namespace imports

An entire library can be imported under a single namespace identifier using
`import * as`:

```zena
import * as math from 'zena:math';

let result = math.min(10, 20);
```

In Zena, namespace imports are compiled as structural record values
(`RecordType`). The imported identifier `math` is a read-only variable whose
record fields are the exported values of the target library. Because namespace
imports are first-class records, they can be stored in variables, passed to
functions, and destructured:

```zena
let { min, max } = math;
```

### Exports

Declarations are exported inline by prefixing the declaration with `export`:

```zena
export let timeout = 5000;
export var activeConnections = 0;

export function connect(): void {
  activeConnections += 1;
}

export class Client {
  id: i32;
  new(this.id);
}

export type ID = i64;
```

Existing declarations can also be exported with an export clause:

```zena
let version = 1;
let internalName = "engine";

export { version, internalName as name };
```

### Re-exports

Named symbols can be re-exported directly from another library:

```zena
export { Point, distance } from './geometry.zena';
export { Formatter as PrettyPrinter } from './format.zena';
```

All public exports from another library can be aggregated and re-exported using
`export * from`:

```zena
export * from './types.zena';
export * from './errors.zena';
```

If two libraries re-exported via `export *` declare an export with the same
name, referencing that ambiguous name from the re-exporting library is a
compile-time error.

## Host imports

External functions provided by the host environment (such as JavaScript or a
WASI interface) are declared using `declare function` paired with the
`@external` decorator:

```zena
@external("env", "readTimestamp")
declare function readTimestamp(): i64;

@external("wasi:clocks/monotonic-clock@0.3.0", "now")
declare function now(): u64;
```

The `@external` decorator takes two arguments: the WebAssembly import module
name and the field name within that module. On a core-module target (`js`,
`freestanding`) the module name is a core import namespace such as `env`; on a
component target (`component`, `zena-cli`) it names a WIT interface. Host
declarations omit the function body and compile directly to WebAssembly
function imports.

## Library resolution

The compiler resolves import specifiers to canonical libraries according to
three formats:

1. **Relative specifiers**: Begin with `./` or `../`. The compiler resolves the
   path relative to the directory of the importing library on disk. Relative
   imports are used between libraries within the same package.
2. **Standard library specifiers**: Begin with `zena:` (such as `zena:core`,
   `zena:collections`, `zena:math`). These resolve against the standard library
   manifest shipped with the compiler.
3. **Package specifiers**: Follow the format `package:library` (such as
   `compiler:parser` or `ui:components`). The compiler resolves the package name
   using the active package manifest (`zena-packages.json`).

The resolver normalizes all paths to a canonical identity. Every library is
loaded, parsed, and checked exactly once, ensuring that types originating from
the same file have identical identity throughout the program.

Circular dependencies between libraries are supported. Mutual dependencies are
resolved across compilation units before code generation.

## Packages and manifests

Multi-package workspaces configure package boundaries and external library
access using a package manifest file named `zena-packages.json`.

```json
{
  "packages": {
    "utils": "./packages/utils/zena/lib",
    "parser": {
      "root": "./packages/parser/zena/lib",
      "exports": {
        "ast": {},
        "scanner": {"path": "lexer/scanner.zena"},
        "console": {
          "virtual": {
            "js": "console/host.zena",
            "component": "console/component.zena"
          }
        }
      }
    },
    "wasi-clocks": {
      "wit": "./wit/clocks"
    }
  }
}
```

A package entry takes one of three forms:

- **Path shorthand string**: `"name": "./path/to/lib"`. All `.zena` libraries
  under that root directory can be imported from outside the package as
  `name:library`.
- **Package object with explicit exports**:
  - `root`: The filesystem directory containing the package source files.
  - `exports`: A map of exposed library names. When `exports` is specified,
    libraries not listed in the map are package-private and cannot be imported
    by code outside the package. Libraries within the package can still reference
    them using relative paths.
  - `path`: Overrides the entry file for a library relative to `root`.
  - `virtual`: Target-conditional mapping. Selects different library files based
    on the compilation target (`js`, `zena-cli`, `freestanding` or
    `component`).
- **WIT-backed package**: `"wit": "./path"`. Configures a package backed by
  WebAssembly Component Model WIT interfaces. The compiler synthesizes
  declarations directly from the WIT definitions.

## Initialization order

When a Zena program is compiled, the compiler computes a topological sort of all
reachable libraries based on their import dependencies:

1. If library `A` imports library `B`, library `B` is ordered before library `A`.
2. Top-level variables in each library evaluate in lexical declaration order.
3. Once all dependency libraries have completed initialization, the main library
   initializes and invokes `main()`.

In the presence of circular dependencies, the compiler breaks the cycle at an
arbitrary link in the cycle. Top-level variables should not depend on
uninitialized state from circular imports during library instantiation.

## WebAssembly representation

A Zena program compiles all reachable libraries into a single WebAssembly module:

- **Top-level variables**: Library-level variables compile to WebAssembly
  globals (`global`). Immutable variables (`let`) with constant initializers
  become immutable globals. Variables with non-constant expressions initialize
  during module startup inside a synthetic start function.
- **Top-level functions**: Emitted as WebAssembly functions (`func`) with
  mangled internal names reflecting their canonical library path.
- **Host imports**: Lower to WebAssembly import entries:
  `(import "module" "field" (func ...))`.
- **Namespace imports**: Compiled into WebAssembly GC struct instances whose
  fields store function references and global values.
- **Dead code elimination**: The compiler analyzes reachability across all
  libraries starting from `main()` and exported declarations, discarding unused
  functions, classes, and variables from the emitted WebAssembly binary.
- **Entry export**: The entry function is exported from the WebAssembly module
  as `(export "main" (func $main))`.
