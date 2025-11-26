# Module System Design

## Overview

Zena uses a file-based module system. Each file is treated as a separate module with its own scope.

## Module Semantics

### File-as-Module

- Every `.zena` source file is a module.
- Top-level declarations (variables, functions, classes) are scoped to the module unless explicitly exported.
- Modules do not pollute the global namespace.

### Scopes

1.  **Global Scope**: Contains built-in types (`i32`, `boolean`, etc.) and implicitly imported standard library classes (`String`, `Array`, `Map`).
2.  **Module Scope**: Contains top-level declarations within a file and imported symbols.
3.  **Local Scope**: Block-level scopes within functions, loops, etc.

### Exports

To make a symbol available to other modules, it must be exported using the `export` keyword.

```typescript
// math.zena
export const add = (a: i32, b: i32) => a + b;
```

### Imports

(Proposed Syntax)
Modules can import exported symbols from other modules.

```typescript
// main.zena
from './math.zena' import { add }
// or
import { add } from './math.zena';
```

_Note: For the bootstrapping phase, we may rely on a simpler resolution or implicit inclusion for standard library components._

## Implicit Imports (The Prelude)

Certain core classes are ubiquitous and have literal syntax support in the language. These are implicitly imported into every module.

- **`String`**: Backs string literals `"hello"`.
- **`Array<T>`**: Backs array literals `#[1, 2, 3]`.
- **`Map<K, V>`**: Backs map literals `#{ key: val }`.

These classes are defined in the standard library but are available globally.

## Resolution & Compilation

1.  **Entry Point**: The compiler starts at a specified entry file.
2.  **Dependency Graph**: It parses imports to build a dependency graph.
3.  **Prelude Injection**: The "Prelude" modules (containing `String`, `Array`, `Map`) are automatically added as dependencies for every module.
4.  **Dead Code Elimination**: Only used symbols are emitted.
