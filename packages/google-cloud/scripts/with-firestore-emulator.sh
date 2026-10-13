#!/usr/bin/env bash
# Starts the Firestore emulator on a free local port, runs the given
# command with FIRESTORE_EMULATOR_HOST set to it, and stops the emulator.
#
# The emulator is a Java program that firebase-tools downloads. Java comes
# from PATH, or from nixpkgs when it is not there; the emulator's jar is
# FIRESTORE_EMULATOR_JAR, or the newest one firebase-tools has downloaded,
# which this script downloads first when there is none.
set -euo pipefail

nixpkgs_run() {
  local package=$1
  shift
  nix shell "nixpkgs#$package" -c "$@"
}

java_cmd=(java)
if ! command -v java >/dev/null; then
  if ! command -v nix >/dev/null; then
    echo "with-firestore-emulator: needs java on PATH, or nix to provide it" >&2
    exit 2
  fi
  java_cmd=(nix shell nixpkgs#jdk21_headless -c java)
fi

newest_jar() {
  ls -1 "$HOME"/.cache/firebase/emulators/cloud-firestore-emulator-v*.jar 2>/dev/null | sort -V | tail -1
}

jar=${FIRESTORE_EMULATOR_JAR:-$(newest_jar || true)}
if [ -z "$jar" ]; then
  echo "with-firestore-emulator: downloading the emulator" >&2
  if command -v firebase >/dev/null; then
    firebase setup:emulators:firestore >&2
  else
    nixpkgs_run firebase-tools firebase setup:emulators:firestore >&2
  fi
  jar=$(newest_jar)
fi

port=$(node -e "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });")
log=$(mktemp -t firestore-emulator.XXXXXX)
"${java_cmd[@]}" -jar "$jar" --host=127.0.0.1 --port="$port" >"$log" 2>&1 &
emulator=$!
trap 'kill "$emulator" 2>/dev/null || true; rm -f "$log"' EXIT

for _ in $(seq 1 120); do
  if node -e "require('net').connect($port, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1));"; then
    break
  fi
  if ! kill -0 "$emulator" 2>/dev/null; then
    echo "with-firestore-emulator: the emulator exited:" >&2
    cat "$log" >&2
    exit 2
  fi
  sleep 0.5
done

FIRESTORE_EMULATOR_HOST=127.0.0.1:$port "$@"
