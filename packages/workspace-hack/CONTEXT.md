# workspace-hack Context (For AI Agents)

`packages/workspace-hack` makes every crate in the Cargo workspace resolve
the same features for the dependencies they share, so the three binaries
share one wasmtime and Cranelift build. The README explains why that takes
a crate of its own and how to check it.

## Rules

- **Never edit the HAKARI SECTION of `Cargo.toml` by hand.** It is
  `cargo hakari generate`'s output. Settings go in
  `.config/hakari.toml` at the repository root.
- **After any change to a Rust dependency**, in any crate's `Cargo.toml`
  or in `Cargo.lock`, run `cargo hakari generate` and
  `cargo hakari manage-deps` and commit what they change. This includes
  bumping a version, adding or removing a feature, and adding a crate.
- **A new crate in the workspace** gets its `workspace-hack` dependency
  from `cargo hakari manage-deps`. Without it, building that crate alone
  resolves its own features again.
- **A merge or rebase conflict in `Cargo.toml`** has no conflict markers:
  `.gitattributes` makes git treat the file as binary, since markers would
  break cargo. Take either side, then run `cargo hakari generate` on the
  merged dependencies.
- **Leave `build.rs` and `src/lib.rs` as they are.** They are hakari's
  stubs: the build script is what makes cargo honor the crate's
  `[build-dependencies]`, which unify the features build scripts and
  procedural macros use.

## When CI fails on "Check the workspace-hack crate"

`cargo hakari generate --diff` or `cargo hakari manage-deps --dry-run`
would change something: a dependency changed and the two commands were not
run. Run them and commit the result. The suite itself still passes in that
state, because a stale workspace-hack only costs a second copy of wasmtime
in a cold build.

## Diagnosing a split

If a cold build compiles wasmtime more than once, compare the
`libwasmtime-<hash>.rlib` each binary links (the loop in the README), and
use `cargo hakari explain <crate>` to see which members ask for which of
that crate's features. A dependency that only one platform uses is unified
only on the platforms listed in `.config/hakari.toml`.
