#!/usr/bin/env bash
#
# Runs one of the App View's operator commands (registry/main) on this
# machine, against one environment (env.sh), with the configuration its
# service runs with: the same variables, its secrets read from Secret
# Manager, and Google credentials of its service account, which you act
# as (deploy:setup lets the gcloud account that ran it). For the commands
# that change the live service's data:
#
#   PDS_ENV=staging ZENA_GCP_PROJECT=meta-garage-420114 packages/registry/deploy/operator.sh \
#     create-scope zena --owner did:plc:... [--recovery-key did:key:...]
#   ... operator.sh sync-handles
#   ... operator.sh sync-indexes
#   ... operator.sh set-limit router.acme.pkg-staging.zena-lang.dev packageBytes 134217728
#   ... operator.sh set-limit acme.pkg-staging.zena-lang.dev scopeActions default
#
# It runs packages/registry/src/main.zena with the repository's zena-cli,
# so build that first (npm run build -w @zena-lang/zena-cli). The access
# token lasts an hour, which is more than any of these takes.

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

case "${1:-}" in
  create-scope | sync-handles | sync-indexes | set-limit) ;;
  *)
    echo "usage: operator.sh create-scope <name> --owner <did> [--recovery-key <did:key>]... | sync-handles | sync-indexes" >&2
    echo "       | set-limit <DID or handle> <limit> <number>|default" >&2
    exit 2
    ;;
esac

# Exported, so that no secret is on a command line.
for pair in "${APP_VIEW_VARS[@]}"; do
  export "${pair?}"
done
for pair in "${APP_VIEW_SECRETS[@]}"; do
  export "${pair%%=*}=$(gcloud secrets versions access latest --secret "${pair#*=}" --project "$PROJECT")"
done
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token --impersonate-service-account "$SERVICE_ACCOUNT_EMAIL" \
  2> /dev/null)" || {
  echo "gcloud could not act as $SERVICE_ACCOUNT_EMAIL: run npm run deploy:setup -w @zena-lang/registry," >&2
  echo "which lets the account it runs as do so (roles/iam.serviceAccountTokenCreator)" >&2
  exit 2
}
export GOOGLE_OAUTH_ACCESS_TOKEN

echo "running $1 against $PDS_ENV as $SERVICE_ACCOUNT_EMAIL"
cd ../../..
exec ./target/release/zena-cli run packages/registry/src/main.zena -- "$@"
