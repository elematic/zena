#!/usr/bin/env bash
#
# Maps the environment's two names to their Cloud Run services, once,
# after the first deploy: the App View's (DOMAIN) and padstone's
# (PDS_DOMAIN). It writes the records the mappings ask for: the App View's
# into the environment's zone, and padstone's into zena-lang.dev's. A name
# mapped to another service, as padstone's was when one service ran both,
# is mapped again, and answers nothing until its new certificate is
# provisioned.
#
#   PDS_ENV=staging npm run deploy:domain -w @zena-lang/registry
#
# Domain mappings are a beta command, so this needs gcloud's beta
# component: `gcloud components install beta`, or a gcloud that has it.
# zena-lang.dev must be verified for your account (it is, if you mapped the
# website). Google then provisions the certificates, which can take a while
# after the records are in.

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

# Maps the name $1 to the service $2. A mapping names one service and
# cannot be changed, so one to another service is deleted and made again.
map() {
  local name="$1" service="$2" current
  echo "==> Mapping $name to $service"
  current="$(gcloud beta run domain-mappings describe --domain "$name" --project "$PROJECT" --region "$REGION" \
    --format 'value(spec.routeName)' 2> /dev/null || true)"
  if [ "$current" = "$service" ]; then
    echo "    exists"
    return
  fi
  if [ -n "$current" ]; then
    echo "    mapped to $current; mapping it again"
    gcloud beta run domain-mappings delete --domain "$name" --project "$PROJECT" --region "$REGION" --quiet
  fi
  gcloud beta run domain-mappings create --service "$service" --domain "$name" \
    --project "$PROJECT" --region "$REGION" --quiet
}
map "$DOMAIN" "$APP_VIEW_SERVICE"
map "$PDS_DOMAIN" "$PDS_SERVICE"

echo "==> Records for $DOMAIN in $ZONE"
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

# The PDS's name is beside the domain, under zena-lang.dev rather than in
# the environment's zone, so its record, the CNAME a subdomain's mapping
# asks for, goes in zena-lang.dev's zone.
echo "==> Records for $PDS_DOMAIN"
find_parent_zone
if [ -z "$PARENT_ZONE" ]; then
  echo "    zena-lang.dev. is not a Cloud DNS zone in $PARENT_PROJECT, so add this record where"
  echo "    zena-lang.dev's DNS is kept (or set DNS_PARENT_PROJECT and DNS_PARENT_ZONE in $SETTINGS,"
  echo "    and run this again):"
  echo "      ${PDS_DOMAIN}.  CNAME  ghs.googlehosted.com."
elif gcloud dns record-sets describe "${PDS_DOMAIN}." --type CNAME --zone "$PARENT_ZONE" \
  --project "$PARENT_PROJECT" > /dev/null 2>&1; then
  echo "    CNAME exists in $PARENT_ZONE"
else
  gcloud dns record-sets create "${PDS_DOMAIN}." --type CNAME --ttl 300 --rrdatas ghs.googlehosted.com. \
    --zone "$PARENT_ZONE" --project "$PARENT_PROJECT" --quiet > /dev/null
  echo "    CNAME ghs.googlehosted.com. in $PARENT_ZONE"
fi

echo
echo "Once the certificates are ready, https://${PDS_DOMAIN}/.well-known/did.json and https://${DOMAIN}/"
echo "answer. Watch them with:"
echo "  gcloud beta run domain-mappings describe --domain $PDS_DOMAIN --project $PROJECT --region $REGION"
echo "  gcloud beta run domain-mappings describe --domain $DOMAIN --project $PROJECT --region $REGION"
