#!/bin/bash
# Syncs WIT parser tests from the upstream wasm-tools repository.
#
# Usage:
#   ./sync-upstream-tests.sh [path-to-wasm-tools]
#
# If no path is provided, clones wasm-tools to a temp directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="$SCRIPT_DIR/tests"

# Source repo path (clone if not provided)
if [[ $# -ge 1 ]]; then
  WASM_TOOLS_DIR="$1"
  if [[ ! -d "$WASM_TOOLS_DIR" ]]; then
    echo "Error: Directory not found: $WASM_TOOLS_DIR"
    exit 1
  fi
  CLEANUP_REPO=false
else
  WASM_TOOLS_DIR=$(mktemp -d)
  CLEANUP_REPO=true
  echo "Cloning wasm-tools to $WASM_TOOLS_DIR..."
  git clone --depth 1 https://github.com/bytecodealliance/wasm-tools.git "$WASM_TOOLS_DIR"
fi

UPSTREAM_TESTS="$WASM_TOOLS_DIR/crates/wit-parser/tests/ui"

if [[ ! -d "$UPSTREAM_TESTS" ]]; then
  echo "Error: Upstream tests not found at $UPSTREAM_TESTS"
  if [[ "$CLEANUP_REPO" == "true" ]]; then
    echo "Cloned repo is at: $WASM_TOOLS_DIR"
  fi
  exit 1
fi

# Get the commit hash for tracking
UPSTREAM_COMMIT=$(cd "$WASM_TOOLS_DIR" && git rev-parse HEAD)
echo "Syncing from wasm-tools commit: $UPSTREAM_COMMIT"

# Remove existing tests (except our config file)
echo "Cleaning existing tests..."
find "$TESTS_DIR" -mindepth 1 -maxdepth 1 ! -name 'test-config.json' -exec rm -rf {} +

# Copy all tests from upstream
echo "Copying tests from upstream..."
cp -R "$UPSTREAM_TESTS"/* "$TESTS_DIR/"

# Count what we copied
SUCCESS_COUNT=$(find "$TESTS_DIR" -maxdepth 1 -name '*.wit.json' | wc -l | tr -d ' ')
ERROR_COUNT=$(find "$TESTS_DIR/parse-fail" -name '*.wit.result' 2>/dev/null | wc -l | tr -d ' ')

echo ""
echo "Sync complete!"
echo "  Success tests: $SUCCESS_COUNT"
echo "  Error tests: $ERROR_COUNT"
echo "  Upstream commit: $UPSTREAM_COMMIT"
echo ""
echo "Update test-config.json if any tests need to be skipped."

# Cleanup temp clone if we created it
if [[ "$CLEANUP_REPO" == "true" ]]; then
  echo ""
  read -p "Delete cloned repo at $WASM_TOOLS_DIR? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "$WASM_TOOLS_DIR"
    echo "Deleted."
  else
    echo "Kept at: $WASM_TOOLS_DIR"
  fi
fi
