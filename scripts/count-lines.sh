#!/usr/bin/env bash
# Count lines of code in the Zena repository using cloc
# Separates source code from test code

set -euo pipefail

cd "$(dirname "$0")/.."

# Check if cloc is available
if ! command -v cloc &> /dev/null; then
  echo "Error: cloc is not installed. Run 'direnv reload' to get it from nix."
  exit 1
fi

# Define Zena as a custom language for cloc (uses // comments like TypeScript)
ZENA_DEF=$(mktemp)
cat > "$ZENA_DEF" << 'EOF'
Zena
    filter remove_matches ^\s*$
    filter remove_inline //.*$
    filter call_regexp_common C
    extension zena
    3rd_gen_scale 1.00
EOF

echo "📊 Zena Repository Line Count (using cloc)"
echo "==========================================="
echo ""

# Common exclusions
EXCLUDE_DIRS="node_modules,.wireit,.git,_site"
EXCLUDE_LIST_FILE=$(mktemp)

# Exclude packages/*/lib/ directories (build outputs)
find ./packages -maxdepth 2 -type d -name "lib" 2>/dev/null >> "$EXCLUDE_LIST_FILE"

echo "SOURCE CODE (excluding tests)"
echo "------------------------------"
cloc . \
  --read-lang-def="$ZENA_DEF" \
  --exclude-dir="$EXCLUDE_DIRS" \
  --exclude-list-file="$EXCLUDE_LIST_FILE" \
  --not-match-f='(_test\.|\.test\.)' \
  --fullpath --not-match-d='/(test|tests)/' \
  --include-ext=ts,js,zena \
  --quiet

echo ""
echo "TEST CODE (test files + test directories)"
echo "------------------------------------------"
# Create a file list for test files
TEST_FILES=$(mktemp)

# Files matching test patterns
find . -type f \( -name "*.ts" -o -name "*.js" -o -name "*.zena" \) \
  ! -path "*/node_modules/*" \
  ! -path "*/.wireit/*" \
  ! -path "*/.git/*" \
  ! -path "*/_site/*" \
  | grep -v -E '^./packages/[^/]+/lib/' \
  | grep -E "(_test\.|\.test\.|/test/|/tests/)" \
  > "$TEST_FILES" 2>/dev/null || true

cloc --list-file="$TEST_FILES" \
  --read-lang-def="$ZENA_DEF" \
  --quiet

echo ""
echo "DOCUMENTATION (Markdown)"
echo "------------------------"
cloc ./docs \
  --include-ext=md \
  --quiet

# Cleanup
rm -f "$ZENA_DEF" "$EXCLUDE_LIST_FILE" "$TEST_FILES"
