## atproto

### Added

- AT Protocol data model, DAG-CBOR, CIDs, repository Merkle Search Trees and proofs, DID and handle resolution, XRPC, and service authentication.

## compiler

### Added

- Self-hosted Zena compiler targeting WebAssembly GC and the Component Model (`zena-component`, `component`, `core`, `js`, and `zena-js` targets) with the ZIR backend.

## google-cloud

### Added

- Google Cloud client libraries for Firestore, Cloud Storage, Cloud DNS, and Cloud KMS.

## markdown

### Added

- CommonMark and GitHub Flavored Markdown parser, syntax tree, plugin API, and HTML renderer.

## package-manager

### Added

- Package manifest and workspace readers, source archives, registry client methods, dependency version resolution, lockfiles, and package cache fetching.

## pds

### Added

- AT Protocol Personal Data Server (PDS) with managed accounts and Firestore or in-memory storage.

## protobuf

### Added

- Protocol Buffers schema parser, code generator, wire encoder/decoder, and gRPC over HTTP support.

## registry

### Added

- Zena package registry App View service, XRPC methods, and server-rendered web interface.

## semver

### Added

- Semantic version parsing, comparison, and npm-compatible version range matching.

## wit-parser

### Added

- WebAssembly Interface Types (WIT) parser, document resolver, and component encoder.

## workflow

### Added

- Incremental workflow graph engine with input fingerprinting, step caching, and background services.

## zebra

### Added

- Incremental build orchestrator for Zena (`zena-package.json`), standalone Zebra (`zebra.json`), and Wireit (`package.json`) workspaces.

## cli

### Added

- Standalone `zena` command bundling the CLI module and standard library for macOS (Apple Silicon), Linux (x86_64 and ARM64), and Windows (x86_64).
- Commands for compiling (`build`), running (`run`), testing (`test`), formatting (`fmt`), linting (`lint`), API documentation (`doc`), benchmarking (`bench`), language server (`lsp`), precompiling (`precompile`), and package management (`pkg`).

## zenadoc

### Added

- Public API documentation extractor emitting structured JSON for Zena packages.

## formatter

### Added

- Code formatter for Zena source files.

## lint

### Added

- Lint rules and automated source fixes for Zena libraries.
