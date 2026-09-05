# Vendored WASI WIT

The WASI preview 3 interfaces Zena programs import as WIT-typed
modules (`import { getRandomBytes } from 'wasi:random/random'`). The
`wasi` entry in `zena-packages.json` points here, and the compiler
host synthesizes typed Zena modules from these files on demand.

Excerpted from the upstream WASI proposals, with two edits:

- **Versions are pinned to plain `0.3.0`** — the upstream drafts carry
  rc-suffixed versions (`0.3.0-rc-2025-09-16`), and `wasmtime`
  registers the interfaces at `0.3.0`, which is the string an import
  must match.
- **Only the declarations Zena programs reach are kept** — an imported
  interface is emitted whole into the component's import surface, and
  a minimal subset is a smaller contract for a host to satisfy.

The stdio interfaces the standard library itself binds are baked in
the compiler (`wasi-interfaces.zena`) for now; folding them into this
directory — and retiring the baked strings — is the recorded plan
there. Until then, packages baked there must not also appear here: the
import encoder splices both sources into one document, and a package
declared twice is an error.
