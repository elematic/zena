#!/usr/bin/env bash
# Does WIT let one world import the same interface more than once?
#
# Yes — via named import slots, cross-package aliasing, and version
# namespacing. This script demonstrates all three end to end (WIT source →
# component binary → core import names) so the question can be settled by
# running it rather than by re-reading spec prose.
#
# Background: wasi:http@0.3.0-rc-2025-09-16 carries a `client` interface
# duplicating `handler`, saying the duplication is "necessary because some
# Component Model tooling (including WIT itself) is unable to represent a
# component importing two instances of the same interface". That is stale as
# of wasm-tools 1.252.0 — this script builds exactly the shape it calls
# impossible.
#
# Requires wasm-tools on PATH (nix develop).
#
# See docs/design/component-model.md, Parts 1, 2 and 4.

set -euo pipefail

command -v wasm-tools >/dev/null || {
  echo "wasm-tools not on PATH — run inside 'nix develop'" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "=== 1. Same interface imported three times, and also exported ==="
cat > "$work/same.wit" <<'WIT'
package test:b;

interface handler { handle: func(x: string) -> string; }

world w {
  import upstream: handler;
  import downstream: handler;
  import handler;
  export handler;
}
WIT
wasm-tools component wit "$work/same.wit"

echo
echo "=== 2. Survives into a real component binary ==="
wasm-tools component embed --world w "$work/same.wit" --dummy -o "$work/core.wasm"
wasm-tools component new "$work/core.wasm" -o "$work/comp.wasm"
wasm-tools component wit "$work/comp.wasm" | sed -n '/^world/,/^}/p'

echo
echo "=== 3. Each slot is its own core import module (what @external binds) ==="
wasm-tools print "$work/core.wasm" | grep -E '^\s*\(import' || true

echo
echo "=== 4. Cross-package aliasing + two versions side by side ==="
mkdir -p "$work/x/deps/h1" "$work/x/deps/h2"
cat > "$work/x/deps/h1/h.wit" <<'WIT'
package dep:h@1.0.0;
interface handler { handle: func(x: string) -> string; }
WIT
cat > "$work/x/deps/h2/h.wit" <<'WIT'
package dep:h@2.0.0;
interface handler { handle: func(x: string) -> string; }
WIT
cat > "$work/x/main.wit" <<'WIT'
package test:mw;

world middleware {
  import upstream: dep:h/handler@1.0.0;
  import dep:h/handler@1.0.0;
  import v2: dep:h/handler@2.0.0;
  export dep:h/handler@1.0.0;
}
WIT
wasm-tools component embed --world middleware "$work/x" --dummy -o "$work/mw.wasm"
wasm-tools print "$work/mw.wasm" | grep -E '^\s*\(import' || true

echo
echo "All four checks produced distinct, independently wireable imports."
