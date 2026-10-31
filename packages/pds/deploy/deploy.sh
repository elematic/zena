#!/usr/bin/env bash
#
# Deploys the image `deploy:image` pushed to one environment of the package
# host (env.sh), configured as pds:service reads it, and checks that it
# answers.
#
#   PDS_ENV=staging ZENA_GCP_PROJECT=meta-garage-420114 npm run deploy -w @zena-lang/pds
#
# Every prompt is answered by a flag, and --quiet turns off the rest, since
# this runs under wireit.

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

ENV_VARS="PDS_STORAGE=firestore"
ENV_VARS+=",PDS_FIRESTORE_DATABASE=${DATABASE}"
ENV_VARS+=",PDS_KEY_ENCRYPTION_KMS_KEY=${SIGNING_KEYS_KMS_NAME}"
ENV_VARS+=",PDS_TENANT=${TENANT}"
ENV_VARS+=",PDS_BLOB_BUCKET=${BUCKET}"
ENV_VARS+=",PDS_HOST_DOMAIN=${DOMAIN}"
ENV_VARS+=",PDS_HANDLE_RECORDS=cloud-dns"
ENV_VARS+=",PDS_DNS_ZONE=${ZONE}"
ENV_VARS+=",PDS_DNS_PROJECT=${PROJECT}"
ENV_VARS+=",PDS_PLC=${PLC_MODE}"
ENV_VARS+=",GOOGLE_CLOUD_PROJECT=${PROJECT}"
SECRETS="PDS_JWT_SECRET=${JWT_SECRET}:latest"
if [ "$ROTATION_KMS" = 1 ]; then
  ENV_VARS+=",PDS_ROTATION_KMS_KEY=${KMS_KEY_VERSION}"
else
  SECRETS+=",PDS_ROTATION_KEY=${SECRET}:latest"
fi
if [ -n "$ADMIN_DIDS" ]; then
  # Spaces, since --set-env-vars splits on commas.
  ENV_VARS+=",PDS_ADMIN_DIDS=${ADMIN_DIDS//,/ }"
fi
if [ -n "$OFFLINE_ROTATION_KEY" ]; then
  ENV_VARS+=",PDS_OFFLINE_ROTATION_KEY=${OFFLINE_ROTATION_KEY}"
elif [ "$PDS_ENV" = production ]; then
  echo "production needs the operator's offline rotation key: set ZENA_OFFLINE_ROTATION_KEY to its did:key," >&2
  echo "from zena-cli run packages/pds/zena/main.zena -- generate-key on a machine you trust" >&2
  exit 2
fi

echo "service: $SERVICE"
echo "image:   $IMAGE"
echo

# Public: the package host's methods check their own callers, with
# service-auth tokens, and its reads are public by design.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT_EMAIL" \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRETS" \
  --memory 1Gi \
  --cpu 1 \
  --max-instances 4 \
  --allow-unauthenticated \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo
echo "Deployed at $URL. It answers:"
curl --silent --show-error --fail "$URL/xrpc/com.atproto.server.describeServer"
echo
echo
echo "Map ${DOMAIN} to it once, with npm run deploy:domain -w @zena-lang/pds."
