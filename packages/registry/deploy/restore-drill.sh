#!/usr/bin/env bash
#
# The restore drill: restores the newest backup of one environment's
# database (env.sh) into a new database beside it, checks everything the
# App View and padstone keep there, and deletes it again. A backup that
# was never restored is only a hope, so run it before production's first
# deploy, and then every few months.
#
#   PDS_ENV=staging packages/registry/deploy/restore-drill.sh [--keep]
#
# The check is registry/main's check-store, run on this machine with the
# App View and padstone in one process over the restored copy, as the
# service account, which deploy:setup lets read the drill's copies: every
# account's name, repository, records and signing key, and every release's
# blob in the live bucket. It writes nothing: handle records go to memory.
# With --keep, the copy is left to look at, and the script says how to
# delete it. Deleting it sends the alert for destructive changes
# (alerts.sh), which is expected.
#
# It runs packages/registry/src/main.zena with the repository's zena-cli,
# so build that first (npm run build -w @zena-lang/zena-cli).

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

KEEP=
case "${1:-}" in
  '') ;;
  --keep) KEEP=1 ;;
  *)
    echo "usage: restore-drill.sh [--keep]" >&2
    exit 2
    ;;
esac
DRILL="${DATABASE}-drill-$(date -u +%Y%m%d%H%M)"

echo "==> The newest backup of $DATABASE"
BACKUP="$(gcloud firestore backups list --location "$FIRESTORE_LOCATION" --project "$PROJECT" \
  --filter "database=projects/${PROJECT}/databases/${DATABASE} AND state=READY" \
  --sort-by ~snapshotTime --limit 1 --format 'value(name)')"
if [ -z "$BACKUP" ]; then
  echo "    none is ready: deploy:setup schedules a daily one" >&2
  exit 1
fi
echo "    $BACKUP"

# On the way out, deletes the copy, if the restore made one, unless --keep.
# shellcheck disable=SC2329 # the trap runs it
finish() {
  if ! gcloud firestore databases describe --database "$DRILL" --project "$PROJECT" > /dev/null 2>&1; then
    return
  fi
  if [ -n "$KEEP" ]; then
    echo "==> Kept $DRILL; delete it with"
    echo "    gcloud firestore databases delete --database $DRILL --project $PROJECT"
    return
  fi
  gcloud firestore databases update --database "$DRILL" --project "$PROJECT" --no-delete-protection \
    --quiet > /dev/null
  gcloud firestore databases delete --database "$DRILL" --project "$PROJECT" --quiet > /dev/null
  echo "==> Deleted $DRILL"
}
trap finish EXIT

echo "==> Restoring it into $DRILL"
OPERATION="$(gcloud firestore databases restore --source-backup "$BACKUP" --destination-database "$DRILL" \
  --project "$PROJECT" --format 'value(name)')"
# The restore runs on after gcloud returns, as an operation, and the copy
# can be read once that is done. (When gcloud waited, it named the database.)
if [[ "$OPERATION" == */operations/* ]]; then
  DONE=
  for _ in $(seq 1 120); do
    DONE="$(gcloud firestore operations describe "$OPERATION" --database "$DRILL" --project "$PROJECT" \
      --format 'value(done)')"
    if [ "$DONE" = True ]; then
      break
    fi
    sleep 15
  done
  if [ "$DONE" != True ]; then
    echo "    not restored after 30 minutes: $OPERATION" >&2
    exit 1
  fi
  ERROR="$(gcloud firestore operations describe "$OPERATION" --database "$DRILL" --project "$PROJECT" \
    --format 'value(error.message)')"
  if [ -n "$ERROR" ]; then
    echo "    the restore failed: $ERROR" >&2
    exit 1
  fi
fi
echo "    restored"

echo "==> Checking it"
# The App View's configuration, but with padstone in the same process over
# the copy, and handle records in memory.
DRILL_VARS=()
for pair in "${APP_VIEW_VARS[@]}"; do
  case "${pair%%=*}" in
    APP_VIEW_PDS_URL | APP_VIEW_STORAGE | APP_VIEW_FIRESTORE_DATABASE | APP_VIEW_TENANT | APP_VIEW_BUCKET | \
      APP_VIEW_HANDLE_RECORDS | APP_VIEW_DNS_ZONE | APP_VIEW_DNS_PROJECT) ;;
    *) DRILL_VARS+=("$pair") ;;
  esac
done
DRILL_VARS+=(
  "APP_VIEW_HANDLE_RECORDS=memory"
  "PDS_STORAGE=firestore"
  "PDS_FIRESTORE_DATABASE=${DRILL}"
  "PDS_TENANT=${TENANT}"
  "PDS_BLOB_BUCKET=${BUCKET}"
  "PDS_KEY_ENCRYPTION_KMS_KEY=${SIGNING_KEYS_KMS_NAME}"
  "PDS_PUBLIC_URL=https://${PDS_DOMAIN}"
)
set +e
(
  set -e
  export_service_environment "${DRILL_VARS[@]}"
  cd ../../..
  ./target/release/zena-cli run packages/registry/src/main.zena -- check-store
)
STATUS=$?
set -e
if [ "$STATUS" = 0 ]; then
  echo "==> The drill passed: $BACKUP restores, and everything in it checks"
else
  echo "==> The drill failed: see the problems above" >&2
fi
exit "$STATUS"
