# Capabilities and Code Isolation

## Status

- **Status**: Proposed
- **Date**: 2025-12-31

## Overview

This document will describe the design for capability-based I/O and code
isolation in Zena. These features enable fine-grained control over what
resources (filesystem, network, etc.) different parts of a program can access.

## Motivation

Several problems motivate this design:

1. **Dependency Security**: Unlike Deno's runtime permissions, we want to
   selectively propagate capabilities to dependencies. Library A might get full
   filesystem access while Library B gets read-only or none at all.

2. **Abstraction**: Rather than importing `zena:fs` and getting ambient access
   to the real filesystem, code should work against a `FileSystem` interface.
   This enables testing (mock filesystems), virtualization, and portability.

3. **Macro Security**: Macros need to run at compile time without access to the
   compiler's file I/O capabilities. This is an early use case for the general
   capability model.

4. **Static Verification**: We want compile-time guarantees about what
   capabilities code can access, not just runtime checks.

## Key Concepts

### Capabilities as Values

```zena
// Capability received, not imported
let processFile = (fs: FileSystem, path: string) => {
  let contents = fs.read(path);
  // ...
};
```

### Library Instantiation

Libraries declare their required capabilities as parameters:

```zena
library(fs: FileSystem, net?: Network) {
  export let fetch = (url: string) => { ... };
}
```

### Import Allow-Lists

Modules can restrict what they (and their dependencies) can import:

```zena
@allowImports(['zena:string', 'zena:array'])
module {
  // Can only import pure modules
}
```

## Design

TODO: Full design to be written.

## Related

- `docs/design/macros.md` - Macros as an early use case for restricted modules
- `docs/design/modules.md` - Module system design
