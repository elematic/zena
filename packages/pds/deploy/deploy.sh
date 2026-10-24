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
ENV_VARS+=",PDS_TENANT=${TENANT}"
ENV_VARS+=",PDS_BLOB_BUCKET=${BUCKET}"
ENV_VARS+=",PDS_HOST_DOMAIN=${DOMAIN}"
ENV_VARS+=",PDS_HANDLE_RECORDS=cloud-dns"
ENV_VARS+=",PDS_DNS_ZONE=${ZONE}"
ENV_VARS+=",PDS_DNS_PROJECT=${PROJECT}"
ENV_VARS+=",PDS_PLC=${PLC_MODE}"
ENV_VARS+=",GOOGLE_CLOUD_PROJECT=${PROJECT}"

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
  --set-secrets "PDS_ROTATION_KEY=${SECRET}:latest" \
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
