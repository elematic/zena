# Module System Design

## Overview

Zena uses a file-based module system inspired by JavaScript (ES Modules), but adapted for a compiled, statically-linked language targeting WebAssembly.

## Module Semantics

### File-as-Module

- Every `.zena` source file is a module.
- Top-level declarations (variables, functions, classes) are scoped to the module unless explicitly exported.
- Modules do not pollute the global namespace.

### Scopes

1.  **Global Scope**: Contains built-in types (`i32`, `boolean`, etc.) and implicitly imported standard library classes (`String`, `Array`, `Map`).
2.  **Module Scope**: Contains top-level declarations within a file and imported symbols.
3.  **Local Scope**: Block-level scopes within functions, loops, etc.

## Syntax

### Imports

Imports are **declarations**, not statements. They must appear at the very top of the file, before any other statements or declarations.

Zena supports two syntaxes for importing named exports:

1.  **Standard JS Style**:

    ```zena
    import {add, subtract as sub} from './math.zena';
    ```

2.  **Flipped Style** (Better for autocomplete):
    ```zena
    from './math.zena' import { add, subtract as sub };
    ```

**Specifiers**:

- Must be string literals.
- **Relative Paths**: Must start with `./` or `../`.
- **Extensions**: File extensions are required (e.g., `.zena`).
- **Standard Library**: Use the `zena:` protocol (e.g., `zena:string`).
- **Absolute Paths**: Not supported.
- **Package Specifiers**: `package:path` format via package maps (see below).

### Exports

Symbols are exported using the `export` keyword on the declaration.

```zena
// math.zena
export let add = (a: i32, b: i32) => a + b;

export class Calculator {
  // ...
}
```

## Package Maps

Zena uses **package maps** to resolve bare specifiers (imports that don't start
with `./`, `../`, or `zena:`). A package map is a JSON file that maps package
names to source directories.

### `zena-packages.json`

```json
{
  "packages": {
    "zena-compiler": "./packages/zena-compiler/zena/lib",
    "zena-formatter": "./packages/zena-formatter/zena/lib"
  }
}
```

### Resolution

All non-relative specifiers use the `package:path` format. `zena` is a reserved
package name that maps to the standard library.

```zena
import { String } from 'zena:string';              // stdlib (reserved)
import { parse } from 'zena-compiler:parser';       // user package
import { format } from 'zena-formatter:format';     // user package
```

**Rules:**

1. If the specifier starts with `./` or `../`, resolve as a relative path.
2. Otherwise, split on the first `:` to get `package` and `path`.
3. If the package is `zena`, resolve via the standard library.
4. Otherwise, look up the package name in the `packages` map to get the directory.
5. If there's a subpath, resolve `<directory>/<subpath>.zena`.
6. If there's no subpath, resolve `<directory>/index.zena`.
7. All directory paths in the map are relative to the `zena-packages.json` file.

### CompilerHost Integration

The `CompilerHost.resolve()` method handles three cases:

```
resolve(specifier, referrer):
  if specifier starts with './' or '../'  → relative path resolution
  split on ':'  → package:path
    if package == 'zena'  → stdlib resolution
    else  → package map lookup
```

The host loads `zena-packages.json` at initialization. No recursive lookup (no
`node_modules`-style walking up directories). One manifest, one flat map.

### Rationale

- **No file-system walking**: Resolution is a pure dictionary lookup + path
  join. Fast, deterministic, no surprises.
- **Explicit over implicit**: Every package dependency is listed in one file.
- **Familiar model**: Follows JavaScript import maps
  (`https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap`).
- **Minimal**: No version resolution, no lock files, no registry. Just
  "this name maps to this directory."
- **Future-proof**: When we add a real package manager, it generates this file.
  The compiler never needs to know about package managers.

## Compilation & Resolution

### Static Linking (Bundling)

Since Zena targets WASM, the primary compilation model is **static linking**. All imported modules are compiled and bundled into a single WASM binary.

- **Symbol Mangling**: Internal symbols (variables, functions) from imported modules are renamed (mangled) to avoid collisions in the final WASM binary.
  - Example: `add` in `math.zena` might become `$math.add` or similar unique identifier.
- **Dead Code Elimination**: The compiler should only include symbols that are transitively used from the entry point.

### Host Interop

- **Entry Point Exports**: Only symbols exported from the **main module** (the entry point) are exported from the resulting WASM module to the host (JavaScript).
- **Internal Exports**: Exports from imported modules are visible to other Zena modules but are **not** exposed to the host environment.

### Standard Library (The Prelude)

The "Prelude" is a set of declarations injected into the top of every module's scope (before user code). It handles importing standard library features and setting up global variables.

- **Implicit Imports**: Core modules like `zena:string`, `zena:array`, `zena:map`, and `zena:console` are automatically imported.
- **Globals**: "Globals" are not truly global. They are simply symbols imported from standard modules into the module scope.

#### Conceptual Prelude

This is effectively what the compiler injects at the top of every file:

```zena
import {String} from 'zena:string';
import {Array} from 'zena:array';
import {Map} from 'zena:map';
import {console} from 'zena:console'; // Imported as a read-only binding
```

### Mutable Exports & Optimization

Zena distinguishes between immutable and mutable exports, which has significant implications for optimization.

1.  **Immutable Exports (`export let`)**:
    - Maps to an immutable WASM Global (or constant value).
    - **Optimization**: The compiler can inline values and devirtualize method calls (e.g., turning `console.log` into a direct call).
    - **Default**: Standard library globals like `console` should generally be `let`.

2.  **Mutable Exports (`export var`)**:
    - Maps to a mutable WASM Global.
    - **Optimization**: Access requires reading the global. Method calls require dynamic dispatch (indirect calls) because the object instance might change at runtime.
    - **Usage**: Use sparingly. If a global needs to be swappable (e.g., for mocking), use `var`, but be aware of the performance cost.

#### Mutating Globals

Imports are **read-only bindings**. You cannot reassign an imported symbol directly.

```zena
import {someVar} from './mod.zena';
someVar = 10; // Error: Cannot assign to imported binding.
```

To support mutable shared state, the exporting module must either:

1.  Export a setter function (`export const setSomeVar = (v) => ...`).
2.  Export a mutable container object.

## Implementation Plan

### 1. AST Updates

- Add `ImportDeclaration` node.
  - `specifier`: string
  - `imports`: Array of `{ name: string, alias?: string }`
- ✅ `Module` node contains both AST and metadata (`path`, `isStdlib`, `source`, `imports`, `exports`, `diagnostics`).
- ✅ `Program` is a compiler-created container (not an AST node) for all modules plus the entry point.

### 2. Parser Updates

- Implement `parseImportDeclaration`.
- Support both `import {...} from '...'` and `from '...' import {...}`.
- Enforce "Imports First": Raise a syntax error if an import appears after a non-import statement.

### 3. Compiler Architecture Refactor

Move from a single-file compiler to a multi-file project compiler.

- **`Compiler` Class**:
  - Manages the compilation session.
  - Maintains a `ModuleGraph`.
  - **Resolution**: `resolve(specifier, referrer) -> AbsolutePath`.
  - **Loading**: `load(path) -> SourceCode`.
- **CLI**:
  - Instantiates `Compiler` with a file-system based resolver/loader.
  - Resolves relative paths against the file system.

### 4. Type Checker Updates

- **Symbol Table**: Needs to handle cross-module lookups.
- **Module Interface**: When checking `import { x } from './mod'`, the checker must:
  1.  Load/Check `./mod`.
  2.  Verify `./mod` exports `x`.
  3.  Import the type of `x` into the current scope.

### 5. Code Generator (Bundler)

- **Symbol Renaming**: Implement a strategy to unique-ify names across modules.
- **Concatenation**: Effectively merge the ASTs/IRs of all used modules into one program before emitting WASM.
- **WASM Exports**: Filter exports so only the entry module's exports become WASM exports.
