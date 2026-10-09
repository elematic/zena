#!/usr/bin/env bash
# alloc-hist.sh <label> <compiler.wasm> <entry> [flags...]: allocation histogram of one compile.
set -u
cd "$(dirname "$0")/.."
mkdir -p perf-out
label=$1; compiler=$2; entry=$3; shift 3
ZENA_ALLOC_HIST=1 ZENA_GC_RESERVE_MB=${RESERVE:-1536} ZENA_RUST_LOG=wasmtime::runtime::store::gc=trace \
  \time -f "%e s %M KB" ./target/release/zena-run --dir .::. --dir packages/stdlib/zena::/stdlib \
  "$compiler" "$entry" "$@" -o "perf-out/$label.wasm" > "perf-out/$label.out" 2> "perf-out/$label.log"
tail -1 "perf-out/$label.log"
echo "collections: $(grep -c 'Got GC heap OOM' "perf-out/$label.log")"
wasm-tools print "$compiler" > "perf-out/$label.wat" 2>/dev/null
python3 scripts/alloc-hist.py "perf-out/$label.log" "perf-out/$label.wat" --top "${TOP:-25}"
