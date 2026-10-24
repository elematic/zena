#!/usr/bin/env bash
# Lets a CI run reuse the workspace crates a cached build compiled.
#
# Cargo decides whether a workspace crate is fresh from its source files'
# modification times. A fresh checkout gives every file the time of the
# checkout, so cargo recompiled every workspace crate in every run, even
# when the cached artifacts were compiled from exactly these sources:
# zena-runtime, the three binaries and their links, about two minutes on a
# 4-CPU runner.
#
#   record   After the build: write the SHA-256 and the modification time
#            of each Rust input to target/zena-rust-sources.tsv, beside the
#            artifacts, so the cache saves the two together.
#   restore  After restoring that cache: give each Rust input whose content
#            matches the recorded hash the modification time it had when
#            the cached build compiled it. Cargo then sees what it saw then
#            and reuses what it compiled. An input that changed keeps the
#            checkout's time, newer than any recorded one, and is
#            recompiled, as is everything that depends on it.
#
# The recorded time is restored exactly, not some older one: a build script
# that declares no `rerun-if-changed`, such as workspace-hack's, makes cargo
# store the newest mtime in its package and treat any other value as a
# change, older ones included.
#
# The inputs are the git-tracked files under the paths below. A file cargo
# reads that is not among them keeps the checkout's time, which costs a
# recompile and never a stale artifact.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
manifest=target/zena-rust-sources.tsv
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
    git ls-files -z -- "${paths[@]}" | while IFS= read -r -d '' file; do
      printf '%s\t%s\t%s\n' "$(sha256sum "$file" | cut -d' ' -f1)" "$(stat -c '%.9Y' "$file")" "$file"
    done > "$manifest"
    echo "Recorded $(wc -l < "$manifest") Rust inputs in $manifest"
    ;;
  restore)
    if [ ! -f "$manifest" ]; then
      echo "No $manifest: the workspace crates compile from scratch."
      exit 0
    fi
    matched=0
    while IFS=$'\t' read -r hash mtime file; do
      if [ -f "$file" ] && [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$hash" ]; then
        touch -d "@$mtime" "$file"
        matched=$((matched + 1))
      fi
    done < "$manifest"
    echo "$matched of $(wc -l < "$manifest") Rust inputs match the cached build; the rest recompile."
    ;;
  *)
    echo "usage: $0 record|restore" >&2
    exit 2
    ;;
esac
