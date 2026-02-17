#!/bin/bash
# Script to show WAT output for a Zena program using vtables.
#
# Usage: ./scripts/show-vtable-wat.sh
#
# This compiles a sample program with class inheritance and virtual dispatch,
# then displays the WebAssembly Text (WAT) output with vtable structures highlighted.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_FILE="/tmp/vtable-demo.wasm"
ZENA_FILE="/tmp/vtable-demo.zena"

# Create a minimal Zena program that shows vtable structure
# The helper function takes Animal as parameter, forcing vtable dispatch
cat > "$ZENA_FILE" << 'EOF'
class Animal {
  speak(): i32 {
    return 1;
  }
}

// Helper function forces vtable dispatch - compiler can't devirtualize
// method calls through function parameters (yet)
let callSpeak = (animal: Animal): i32 => animal.speak();

export let main = (): i32 => {
  let animal = new Animal();
  return callSpeak(animal);
};
EOF

echo "==> Compiling vtable demo program (with DCE enabled)..."
node "$PROJECT_ROOT/packages/cli/lib/cli.js" build "$ZENA_FILE" -g --dce -o "$WASM_FILE"

echo ""
echo "==> WASM file: $WASM_FILE ($(wc -c < "$WASM_FILE" | tr -d ' ') bytes)"
echo ""

if command -v wasm-tools &> /dev/null; then
  echo "=== VTABLE GLOBALS (struct.new with ref.func) ==="
  wasm-tools print "$WASM_FILE" | grep -E '^\s*\(global.*ref\.func.*struct\.new' | head -20
  echo ""
  
  echo "=== VIRTUAL DISPATCH (call_ref) ==="
  wasm-tools print "$WASM_FILE" | grep -B 5 'call_ref' | head -40
  echo ""
  
  echo "=== FULL WAT ==="
  echo "Run: wasm-tools print $WASM_FILE"
  echo ""
  
  read -p "Show full WAT? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    wasm-tools print "$WASM_FILE"
  fi
else
  echo "wasm-tools not found. Install it to view WAT output."
  echo "Run: nix-shell -p wasm-tools"
fi
