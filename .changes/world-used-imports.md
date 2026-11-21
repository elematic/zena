## compiler

### Changed

- A component built against a declared world (`--wit`, `--world`) imports the interfaces of the world the program reaches, where it imported every interface of the world. A world that includes `wasi:cli/imports` no longer makes a program that uses none of WASI import all of it ([#1298](https://github.com/elematic/zena/issues/1298)).

## wit-parser

### Added

- `ComponentTypeEncoder.encodeWorld` takes an optional list of interfaces, and then encodes only those of the world's imports and the interfaces they use.
