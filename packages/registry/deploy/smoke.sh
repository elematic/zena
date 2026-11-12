#!/usr/bin/env bash
#
# The smoke test of one environment (env.sh), run after every deploy: it
# checks both names as their clients see them, with no browser and no
# personal account, adds and runs the canary package, and publishes and
# withdraws a version of it as an automation account
# (packages/registry/dev/smoke.zena). It exits 1 if any check fails.
#
#   PDS_ENV=staging npm run deploy:smoke -w @zena-lang/registry
#
# Once per environment, `smoke.sh setup` makes what it uses, as you, signed
# in with `zena pkg login` as an owner of the scope SMOKE_SCOPE (from the
# environment's settings): the canary package `smoke` at 1.0.0,
# and the automation account `smoke-ci`, one of its publishers, whose token
# it keeps in Secret Manager as SMOKE_SECRET.
#
#   PDS_ENV=staging packages/registry/deploy/smoke.sh setup
#
# A withdrawn version's archive stays on padstone, unreferenced, a few
# hundred bytes a run, until unreferenced blobs are cleaned up
# (elematic/zena#669).

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

REPO="$(cd ../../.. && pwd)"
ZENA="$REPO/target/release/zena-cli"
if [ "$PLC_MODE" = staging ]; then
  PLC="https://${DOMAIN}/plc"
else
  PLC=https://plc.directory
fi
export ZENA_REGISTRY="https://${DOMAIN}" ZENA_PLC_DIRECTORY="$PLC"
# A shell that ran the demo points this at the demo's own resolver.
unset ZENA_DNS_OVER_HTTPS

setup() {
  if gcloud secrets describe "$SMOKE_SECRET" --project "$PROJECT" > /dev/null 2>&1; then
    echo "$SMOKE_SECRET exists: $PDS_ENV is set up for the smoke test already" >&2
    exit 2
  fi
  CANARY="$(mktemp -d)"
  trap 'rm -rf "$CANARY"' EXIT
  cat > "$CANARY/zena-package.json" << EOF
{"name": "smoke", "description": "What the registry's smoke test adds and runs", "license": "MIT", "scope": "$SMOKE_SCOPE", "version": "1.0.0"}
EOF
  mkdir -p "$CANARY/src"
  cat > "$CANARY/src/smoke.zena" << 'EOF'
/** The answer the smoke test's program checks for. */
export function answer(): i32 {
  return 42;
}
EOF
  echo "==> The canary, $SMOKE_SCOPE:smoke 1.0.0"
  (cd "$CANARY" && "$ZENA" pkg publish --yes)
  echo "==> The automation account smoke-ci"
  local created token
  created="$("$ZENA" pkg ci create "$SMOKE_SCOPE/smoke-ci")"
  token="$(sed -n 's/^Its token, which is not shown again: //p' <<< "$created")"
  if [ -z "$token" ]; then
    echo "$created" >&2
    exit 1
  fi
  (cd "$CANARY" && "$ZENA" pkg owner add "smoke-ci.$SMOKE_SCOPE.$DOMAIN" --automation)
  printf '%s' "$token" | gcloud secrets create "$SMOKE_SECRET" --project "$PROJECT" \
    --replication-policy automatic --data-file - --quiet
  echo
  echo "Set up. If a step failed part way, finish the rest by hand: zena pkg ci token $SMOKE_SCOPE/smoke-ci"
  echo "gives the account a new token."
}

check() {
  local token scratch
  token="$(gcloud secrets versions access latest --secret "$SMOKE_SECRET" --project "$PROJECT")"
  scratch=".zena/smoke-$(date +%s)"
  cd "$REPO"
  mkdir -p "$scratch"
  trap 'rm -rf "$REPO/$scratch"' EXIT
  SMOKE_APP_VIEW="https://${DOMAIN}" SMOKE_PDS="https://${PDS_DOMAIN}" SMOKE_PLC="$PLC" SMOKE_SCOPE="$SMOKE_SCOPE" \
    SMOKE_HOST_DIR="$REPO/$scratch" SMOKE_REPO="$REPO" ZENA_REGISTRY_TOKEN="$token" \
    "$ZENA" run --allow-spawn --dir "$scratch::/smoke" packages/registry/dev/smoke.zena
}

case "${1:-}" in
  setup) setup ;;
  "") check ;;
  *)
    echo "usage: smoke.sh [setup]" >&2
    exit 2
    ;;
esac
