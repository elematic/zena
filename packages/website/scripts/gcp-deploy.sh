#!/usr/bin/env bash
#
# Deploys the already-built image to Cloud Run.
#
#   scripts/gcp-deploy.sh            deploy and send traffic to the new revision
#   scripts/gcp-deploy.sh preview    deploy with no traffic, reachable at a tag
#
# Run it through `npm run deploy -w @zena-lang/website` or `deploy:preview`.
#
# Every prompt is answered by a flag, and --quiet turns off the rest. This runs
# under wireit, which pipes the child's stdio: an interactive prompt still
# prints, but keystrokes never reach gcloud, so the terminal echoes your answer
# and the command hangs forever waiting for input it cannot receive.

set -euo pipefail

MODE="${1:-deploy}"

PROJECT="${ZENA_GCP_PROJECT:?set ZENA_GCP_PROJECT to the Cloud Run project id}"
REGION="${ZENA_GCP_REGION:-us-central1}"
REPO="${ZENA_GCP_REPO:-cloud-run-images}"
SERVICE=zena-website
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}"

# Public by default: this is a docs site, and testers cannot be expected to hold
# Google accounts and IAM grants. Set ZENA_GCP_ALLOW_UNAUTH to anything other
# than "true" to keep it private instead.
if [ "${ZENA_GCP_ALLOW_UNAUTH:-true}" = "true" ]; then
  AUTH_FLAG=--allow-unauthenticated
else
  AUTH_FLAG=--no-allow-unauthenticated
fi

EXTRA=()
if [ "$MODE" = "preview" ]; then
  # Cloud Run rejects --no-traffic when the service does not exist yet, so the
  # first deploy has to be a plain one.
  EXTRA=(--no-traffic --tag next)
fi

echo "service: $SERVICE"
echo "image:   $IMAGE"
echo "access:  $AUTH_FLAG"
echo

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --memory 512Mi \
  --image "$IMAGE" \
  "$AUTH_FLAG" \
  "${EXTRA[@]}" \
  --quiet

echo
if [ "$MODE" = "preview" ]; then
  echo "Preview URL (no live traffic):"
  gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --format='value(status.traffic.filter("tag:next").extract("url").flatten())'
  echo
  echo "Promote it with: npm run deploy:promote -w @zena-lang/website"
else
  echo "Live at:"
  gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --format='value(status.url)'
fi
