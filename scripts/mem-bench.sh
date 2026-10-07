#!/usr/bin/env bash
# Memory and time measurements for a compiler build (issue #199).
#
# Three numbers per workload, each from one run of the compiler under
# `zena-run` so nothing but the collector configuration differs:
#
#   alloc  peak RSS with ZENA_GC=null. The null collector never
#          collects, so the GC heap only ever grows and its peak is
#          the TOTAL bytes the compile allocated.
#   live   peak RSS with the copying collector and no reserve. The
#          copying heap grows only when an allocation still does not
#          fit after a full collection, so it hovers just above the
#          live set; the peak is a proxy for PEAK LIVE SET.
#   time   wall time at the reserve the real build script uses, which
#          is what a change has to improve.
#
# The `.cwasm` cache key does not include the collector, so the two
# collectors would thrash one cache entry and each pay a fresh cranelift
# compile — whose own peak RSS (~4.8GB) swamps what we are measuring.
# Each collector therefore gets its own copy of the compiler module,
# warmed once before the timed runs.
#
# Usage: scripts/mem-bench.sh [workload ...]   (default: all)
#        MEM_BENCH_REPS=3 scripts/mem-bench.sh cli-module
#        ZENA_PROBE_COMPILER=path/to/cli.wasm scripts/mem-bench.sh
set -uo pipefail

cd "$(dirname "$0")/.."
OUT=perf-out
mkdir -p "$OUT"

COMPILER=${ZENA_PROBE_COMPILER:-packages/zena-compiler/zena/out/cli.wasm}
REPS=${MEM_BENCH_REPS:-1}
ONLY=${MEM_BENCH_ONLY:-}   # alloc | live | time, or empty for all

declare -A ENTRY=(
  [hello]=packages/zena-compiler/zena/test/hello_test.zena
  [cli-module]=packages/zena-cli/zena/main.zena
  [self-hosted]=packages/zena-compiler/zena/cli/main.zena
  [lsp]=packages/language-service/zena/lsp.zena
)
declare -A FLAGS=(
  [hello]=""
  [cli-module]=""
  [self-hosted]="-O2"
  [lsp]=""
)
# The reserve each workload's real build script uses.
declare -A RESERVE=(
  [hello]=0
  [cli-module]=1536
  [self-hosted]=1536
  [lsp]=512
)

# One compiler copy per collector, so each keeps its own .cwasm.
NULL_COMPILER=$OUT/cli-nullgc.wasm
COPY_COMPILER=$OUT/cli-copygc.wasm
for pair in "null:$NULL_COMPILER" "copying:$COPY_COMPILER"; do
  dest=${pair#*:}
  if [[ ! -f $dest || $COMPILER -nt $dest ]]; then
    cp "$COMPILER" "$dest"
    rm -f "${dest%.wasm}.cwasm"
  fi
done

# <label> <collector> <reserve> <entry> <flags...>
run() {
  local label=$1 gc=$2 reserve=$3 entry=$4; shift 4
  local compiler=$COPY_COMPILER
  [[ $gc == null ]] && compiler=$NULL_COMPILER
  # shellcheck disable=SC2086
  \time -f "%e %M" env ZENA_GC="$gc" ZENA_GC_RESERVE_MB="$reserve" \
    ./target/release/zena-run --dir .::. --dir packages/stdlib/zena::/stdlib \
    "$compiler" "$entry" "$@" -o "$OUT/$label.wasm" \
    > "$OUT/$label.log" 2>"$OUT/$label.time"
  if [[ $? -ne 0 ]]; then
    echo "FAIL FAIL"
    return 1
  fi
  tail -1 "$OUT/$label.time"
}

warm() { # a throwaway run per collector so the cranelift compile is cached
  local gc=$1
  run "warm-$gc" "$gc" 0 "${ENTRY[hello]}" >/dev/null 2>&1
}

mib() { awk '{if ($2 ~ /^[0-9]+$/) printf "%.0f", $2/1024; else printf "-"}' <<<"$1"; }
secs() { awk '{if ($1 ~ /^[0-9.]+$/) printf "%.1f", $1; else printf "-"}' <<<"$1"; }

want() { [[ -z $ONLY || $ONLY == "$1" ]]; }

want alloc && warm null
{ want live || want time; } && warm copying

printf '%-14s %-4s %12s %12s %12s\n' workload rep 'alloc MiB' 'live MiB' 'time s'
for w in "${@:-hello cli-module self-hosted lsp}"; do
  entry=${ENTRY[$w]:-}
  if [[ -z $entry ]]; then echo "unknown workload: $w" >&2; continue; fi
  read -r -a extra <<<"${FLAGS[$w]}"
  for ((r = 1; r <= REPS; r++)); do
    a='- -'; l='- -'; t='- -'
    want alloc && a=$(run "$w-null" null 0 "$entry" "${extra[@]}")
    want live && l=$(run "$w-live" copying 0 "$entry" "${extra[@]}")
    want time && t=$(run "$w-time" copying "${RESERVE[$w]}" "$entry" "${extra[@]}")
    printf '%-14s %-4s %12s %12s %12s\n' \
      "$w" "$r" "$(mib "$a")" "$(mib "$l")" "$(secs "$t")"
  done
done
