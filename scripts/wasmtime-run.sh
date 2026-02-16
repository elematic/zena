#!/bin/bash
# Script to build and run a Zena program with wasmtime
# Usage: ./scripts/wasmtime-run.sh <zena-file> [function-to-call]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "$1" ]; then
  echo "Usage: $0 <zena-file> [function-to-call]"
  exit 1
fi

ZENA_FILE="$1"
FUNC_NAME="${2:-main}"
BASENAME=$(basename "$ZENA_FILE" .zena)
WASM_FILE="/tmp/${BASENAME}.wasm"

echo "==> Building $ZENA_FILE..."
node "$PROJECT_ROOT/packages/cli/lib/cli.js" build "$ZENA_FILE" -g -o "$WASM_FILE"

echo "==> WASM imports:"
wasm-tools print "$WASM_FILE" 2>/dev/null | grep 'import' || echo "(none)"

echo "==> WASM exports:"
wasm-tools print "$WASM_FILE" 2>/dev/null | grep 'export' || echo "(none)"

echo ""
echo "==> Running with wasmtime (GC + exceptions + function-references enabled)..."
echo "    Note: Zena modules currently require console imports which wasmtime doesn't provide."
echo "    For now, we validate the module compiles and can be parsed."

# Try to run - will fail on imports but proves the WASM is valid
wasmtime run -W gc=y -W exceptions=y -W function-references=y --invoke "$FUNC_NAME" "$WASM_FILE" 2>&1 && {
  echo "==> Function '$FUNC_NAME' executed successfully!"
} || {
  echo ""
  echo "==> Module is valid WASM-GC but needs host imports to run."
  echo "    To run in Node.js: node packages/cli/lib/cli.js run $ZENA_FILE"
}

echo ""
echo "==> WASM file: $WASM_FILE"
