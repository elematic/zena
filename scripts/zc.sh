#!/bin/bash
set -e

# Setup directories
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
REPO_ROOT="$( dirname "$DIR" )"
STDLIB_DIR="$REPO_ROOT/packages/stdlib/zena"
COMPILER_WASM="$REPO_ROOT/packages/zena-compiler/zena/out/cli.wasm"

if [ ! -f "$COMPILER_WASM" ]; then
    echo "Error: zena/out/cli.wasm not found. Run 'npm run build:cli -w @zena-lang/zena-compiler' first."
    exit 1
fi

# Execute wasmtime with proper flags and directories
wasmtime run \
    -W gc=y -W exceptions=y -W function-references=y \
    --dir .::. \
    --dir "$STDLIB_DIR::/stdlib" \
    --invoke main \
    "$COMPILER_WASM" "$@"
