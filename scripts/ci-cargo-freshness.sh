#!/usr/bin/env bash
# Lets a CI run reuse the workspace crates a cached build compiled.
#
# Cargo decides whether a workspace crate is fresh by comparing its source
# files' modification times with the time it was last compiled. A fresh
# checkout gives every file the time of the checkout, so cargo recompiles
# every workspace crate in every run, even when the cached artifacts were
# compiled from exactly these sources: zena-runtime, the three binaries and
# their links, about two minutes on a 4-CPU runner.
#
#   record   After the build: write the SHA-256 of each Rust input to
#            target/zena-rust-sources.sha256, beside the artifacts, so the
#            cache saves the two together.
#   restore  After restoring that cache: give each Rust input whose content
#            matches the recorded hash a modification time in 2000, older
#            than any artifact. Cargo then reuses what was compiled from it.
#            An input that changed keeps the checkout's time and is
#            recompiled, as is everything that depends on it.
#
# The inputs are the git-tracked files under the paths below. A file cargo
# reads that is not among them keeps the checkout's time, which costs a
# recompile and never a stale artifact.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
manifest=target/zena-rust-sources.sha256
paths=(
  Cargo.toml
  Cargo.lock
  packages/workspace-hack
  packages/zena-runtime
  packages/zena-run
  packages/zena-cli/Cargo.toml
  packages/zena-cli/build.rs
  packages/zena-cli/src
  packages/zenafx/Cargo.toml
  packages/zenafx/src
  packages/zenafx/tests
  packages/zenafx/wit
  packages/stdlib/zena/host-wit
)

case "${1:-}" in
  record)
    mkdir -p target
    git ls-files -z -- "${paths[@]}" | xargs -0 sha256sum > "$manifest"
    echo "Recorded $(wc -l < "$manifest") Rust inputs in $manifest"
    ;;
  restore)
    if [ ! -f "$manifest" ]; then
      echo "No $manifest: the workspace crates compile from scratch."
      exit 0
    fi
    matched=0
    while IFS= read -r line; do
      hash=${line%%  *}
      file=${line#*  }
      if [ -f "$file" ] && [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$hash" ]; then
        touch -d '2000-01-01T00:00:00Z' "$file"
        matched=$((matched + 1))
      fi
    done < "$manifest"
    total=$(wc -l < "$manifest")
    echo "$matched of $total Rust inputs match the cached build; the rest recompile."
    ;;
  *)
    echo "usage: $0 record|restore" >&2
    exit 2
    ;;
esac
