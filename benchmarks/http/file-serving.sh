#!/usr/bin/env bash
# Throughput of serving one file over HTTP from zena-cli (issue #323).
#
# Writes a file of random bytes, serves it with file-server.zena, and
# fetches it with curl: through `serve`, where the host copies the file
# to the connection, and through `/copy/`, where the guest reads it
# first. Python's http.server (sendfile) on the same file is the
# reference. Each fetch's bytes are checked once against the file.
#
# Usage: benchmarks/http/file-serving.sh
#        SIZE_MB=256 RUNS=25 benchmarks/http/file-serving.sh
#
# Run it from a checkout whose zena-cli is built: a dev build compiles
# against the standard library of the checkout it was built from.
set -euo pipefail

cd "$(dirname "$0")/../.."
SIZE_MB=${SIZE_MB:-64}
RUNS=${RUNS:-15}
COPY_RUNS=${COPY_RUNS:-3}
ZENA_PORT=8099
PY_PORT=8098

dir=$(mktemp -d)
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$dir"
}
trap cleanup EXIT

for port in "$ZENA_PORT" "$PY_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then
    echo "something is already listening on port $port" >&2
    exit 1
  fi
done

head -c "${SIZE_MB}M" /dev/urandom > "$dir/file.bin"

wait_for() {
  for _ in $(seq 1 240); do
    curl -s -o /dev/null "$1" && return 0
    sleep 0.5
  done
  echo "no server at $1" >&2
  exit 1
}

# Times `runs` fetches of `url` and prints the median, fastest and
# slowest, with the median's throughput.
measure() {
  local label=$1 url=$2 runs=$3
  curl -s -o "$dir/got.bin" "$url"
  if ! cmp -s "$dir/file.bin" "$dir/got.bin"; then
    echo "$label: the bytes served differ from the file" \
        "($(wc -c < "$dir/got.bin") bytes, expected $(wc -c < "$dir/file.bin"))" >&2
    exit 1
  fi
  local times
  times=$(for _ in $(seq 1 "$runs"); do
    curl -s -o /dev/null -w '%{time_total}\n' "$url"
  done | sort -n)
  awk -v label="$label" -v mb="$SIZE_MB" -v n="$runs" '
    { t[NR] = $1 }
    END {
      med = (n % 2) ? t[(n + 1) / 2] : (t[n / 2] + t[n / 2 + 1]) / 2
      printf "%-28s median %8.1f ms  min %8.1f  max %8.1f  %7.0f MB/s\n",
          label, med * 1000, t[1] * 1000, t[n] * 1000, mb / med
    }' <<< "$times"
}

./target/release/zena-cli run --dir "$dir::/data" \
    benchmarks/http/file-server.zena > "$dir/server.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:$ZENA_PORT/"

echo "${SIZE_MB} MB file, $RUNS runs ($COPY_RUNS for the guest copy)"
measure "zena serve" "http://127.0.0.1:$ZENA_PORT/file.bin" "$RUNS"
measure "zena guest copy" "http://127.0.0.1:$ZENA_PORT/copy/file.bin" "$COPY_RUNS"

if command -v python3 > /dev/null; then
  python3 -m http.server "$PY_PORT" --bind 127.0.0.1 --directory "$dir" \
      > /dev/null 2>&1 &
  pids+=($!)
  wait_for "http://127.0.0.1:$PY_PORT/"
  measure "python http.server" "http://127.0.0.1:$PY_PORT/file.bin" "$RUNS"
fi
