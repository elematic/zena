#!/usr/bin/env bash
#
# Deploys the image `deploy:image` pushed to one environment (env.sh) as
# its two services, configured as pds:service and registry:service read
# them: padstone, which runs pds.wasm, and then the App View, which keeps
# its accounts on it. Then checks that each answers.
#
#   PDS_ENV=staging npm run deploy -w @zena-lang/registry
#
# Every prompt is answered by a flag, and --quiet turns off the rest, since
# this runs under wireit.

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

APP_VIEW_URL="https://${DOMAIN}"
PDS_URL="https://${PDS_DOMAIN}"
# The App View's DID, the did:web of its own name, which padstone trusts.
APP_VIEW_DID="did:web:${DOMAIN}"
# The repository's own zena-run, beside the image's Linux one in deploy/.
ZENA_RUN=../../../target/release/zena-run

# The did:key of the App View's online rotation key, which signs the
# genesis operations of the accounts padstone creates for it, read by the
# App View's own module (registry/main's did-key).
if [ "$ROTATION_KMS" = 1 ]; then
  ROTATION_DID_KEY="$(GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)" \
    "$ZENA_RUN" registry.wasm did-key --kms "$KMS_KEY_VERSION")"
else
  ROTATION_DID_KEY="$(gcloud secrets versions access latest --secret "$SECRET" --project "$PROJECT" |
    "$ZENA_RUN" registry.wasm did-key)"
fi

PDS_VARS="PDS_STORAGE=firestore"
PDS_VARS+=",PDS_FIRESTORE_DATABASE=${DATABASE}"
PDS_VARS+=",PDS_KEY_ENCRYPTION_KMS_KEY=${SIGNING_KEYS_KMS_NAME}"
PDS_VARS+=",PDS_TENANT=${TENANT}"
PDS_VARS+=",PDS_BLOB_BUCKET=${BUCKET}"
PDS_VARS+=",PDS_PUBLIC_URL=${PDS_URL}"
PDS_VARS+=",PDS_TRUSTED_APP_VIEWS=${APP_VIEW_DID}=${ROTATION_DID_KEY}"
PDS_VARS+=",GOOGLE_CLOUD_PROJECT=${PROJECT}"
if [ "$PLC_MODE" = staging ]; then
  # Staging's PLC directory is the App View, which records the operations
  # of the accounts it makes.
  PDS_VARS+=",PDS_PLC_DIRECTORY=${APP_VIEW_URL}/plc"
fi

# The App View's configuration, as env.sh gives it, in gcloud's form.
# A file, since a value such as CLIENT_NOTICE may have commas in it, which
# --set-env-vars would split on. Each value is quoted as YAML reads a
# double-quoted string.
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
for pair in "${APP_VIEW_VARS[@]}"; do
  value="${pair#*=}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s: "%s"\n' "${pair%%=*}" "$value" >> "$ENV_FILE"
done
SECRETS=""
for pair in "${APP_VIEW_SECRETS[@]}"; do
  SECRETS+="${SECRETS:+,}${pair}:latest"
done

echo "services: $PDS_SERVICE, then $APP_VIEW_SERVICE"
echo "image:    $IMAGE"
echo "padstone trusts $APP_VIEW_DID with $ROTATION_DID_KEY"
echo

# Both public: padstone's writes take the App View's tokens, its reads are
# public, and the App View's methods check their own callers. padstone has
# no secrets, since it serves no password sessions: --clear-secrets takes
# away the session secret that deploys before it gave padstone, which it
# would now refuse to start with.
gcloud run deploy "$PDS_SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --image "$IMAGE" \
  --command /app/zena-run \
  --args /app/pds.wasm \
  --service-account "$SERVICE_ACCOUNT_EMAIL" \
  --set-env-vars "$PDS_VARS" \
  --clear-secrets \
  --memory 1Gi \
  --cpu 1 \
  --max-instances 4 \
  --allow-unauthenticated \
  --quiet

gcloud run deploy "$APP_VIEW_SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT_EMAIL" \
  --env-vars-file "$ENV_FILE" \
  --set-secrets "$SECRETS" \
  --memory 1Gi \
  --cpu 1 \
  --max-instances 4 \
  --allow-unauthenticated \
  --quiet

url_of() {
  gcloud run services describe "$1" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'
}
PDS_RUN_URL="$(url_of "$PDS_SERVICE")"
APP_VIEW_RUN_URL="$(url_of "$APP_VIEW_SERVICE")"
echo
echo "Deployed padstone at $PDS_RUN_URL. It answers:"
curl --silent --show-error --fail "$PDS_RUN_URL/xrpc/com.atproto.server.describeServer"
echo
echo "Deployed the App View at $APP_VIEW_RUN_URL. It answers:"
curl --silent --show-error --fail "$APP_VIEW_RUN_URL/xrpc/dev.zena-lang.registry.describeRegistry"
echo
echo
echo "Map ${DOMAIN} and ${PDS_DOMAIN} to them once, with npm run deploy:domain -w @zena-lang/registry."
