# Vendored WASI WIT

The WASI 0.3 interfaces, one file per proposal: `cli`, `clocks`,
`filesystem`, `http`, `random`, `sockets`. The built-in `wasi` package
points here, so a Zena program imports an interface as a WIT-typed
module (`import { getRandomBytes } from 'wasi:random/random'`) and the
compiler host synthesizes its typed declarations from these files on
demand; a declared world (`--wit`) imports them by name without
vendoring them; and the component's import surface carries their true
types, which is what lets `wasmtime` link the component at all.

**Do not edit these files.** They are written by
`dev/vendor-wasi-wit.js` from the corpus `packages/wit-parser/dev/wit-corpus.json`
pins — the WebAssembly/WASI repository at the 0.3.0 release, which
`nix develop` provides as `ZENA_WASI_WIT` and
`packages/wit-parser/dev/fetch-wit-corpus.js` downloads otherwise — and
`npm test -w @zena-lang/stdlib` fails when they differ from it. To move
to a newer WASI: bump the pin, re-run
`npm run vendor:wasi-wit -w @zena-lang/stdlib`, commit both.

Each file is the proposal's `wit/` directory concatenated in name order
under a single package header. Upstream puts the header in only some of
a proposal's files, and the compiler reads a WIT root as its files
concatenated in name order, so a header-less file would join whichever
package sorted before it. Nothing else is changed: the release's
packages are versioned plain `0.3.0`, which is the string `wasmtime`
registers, so the version rewriting an earlier excerpt needed is gone.

An imported interface is emitted whole into the component's import
surface, so a program that imports `wasi:http/types` asks its host for
every method the interface declares. That is the interface's contract,
and a host serving the release serves all of it.
