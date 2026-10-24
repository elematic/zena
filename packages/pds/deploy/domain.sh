#!/usr/bin/env bash
#
# Maps the environment's domain to its Cloud Run service, once, after the
# first deploy, and writes the records the mapping asks for into the
# environment's zone.
#
#   PDS_ENV=staging ZENA_GCP_PROJECT=meta-garage-420114 npm run deploy:domain -w @zena-lang/pds
#
# Domain mappings are a beta command, so this needs gcloud's beta
# component: `gcloud components install beta`, or a gcloud that has it.
# zena-lang.dev must be verified for your account (it is, if you mapped the
# website). Google then provisions the certificate, which can take a while
# after the records are in.

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

echo "==> Mapping $DOMAIN to $SERVICE"
if gcloud beta run domain-mappings describe --domain "$DOMAIN" --project "$PROJECT" --region "$REGION" \
  > /dev/null 2>&1; then
  echo "    exists"
else
  gcloud beta run domain-mappings create --service "$SERVICE" --domain "$DOMAIN" \
    --project "$PROJECT" --region "$REGION" --quiet
fi

echo "==> Records in $ZONE"
TYPES="$(gcloud beta run domain-mappings describe --domain "$DOMAIN" --project "$PROJECT" --region "$REGION" \
  --format 'value(status.resourceRecords[].type)' | tr ';' ' ')"
echo "    the mapping asks for: ${TYPES:-nothing yet}"

# The domain is its zone's apex, which cannot hold a CNAME. A mapping of a
# subdomain asks for a CNAME to ghs.googlehosted.com; at an apex Google's
# front end is reached by these A and AAAA records instead, which
# zena-lang.dev's own mapping uses.
A_RECORDS=216.239.32.21,216.239.34.21,216.239.36.21,216.239.38.21
AAAA_RECORDS=2001:4860:4802:32::15,2001:4860:4802:34::15,2001:4860:4802:36::15,2001:4860:4802:38::15
for type in A AAAA; do
  if [ "$type" = A ]; then rrdatas="$A_RECORDS"; else rrdatas="$AAAA_RECORDS"; fi
  if gcloud dns record-sets describe "${DOMAIN}." --type "$type" --zone "$ZONE" --project "$PROJECT" \
    > /dev/null 2>&1; then
    echo "    $type exists"
  else
    gcloud dns record-sets create "${DOMAIN}." --type "$type" --ttl 300 --rrdatas "$rrdatas" \
      --zone "$ZONE" --project "$PROJECT" --quiet > /dev/null
    echo "    $type $rrdatas"
  fi
done

echo
echo "Once the certificate is ready, https://${DOMAIN}/.well-known/did.json answers. Watch it with:"
echo "  gcloud beta run domain-mappings describe --domain $DOMAIN --project $PROJECT --region $REGION"
