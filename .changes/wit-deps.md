## compiler

### Added

- `--wit <directory>` reads the packages in the directory's `deps/`, each a `.wit` file or a directory of them, as `wasm-tools` and `wit-bindgen` do. A world can then include a world of another package, or import its interfaces ([#1297](https://github.com/elematic/zena/issues/1297)).
