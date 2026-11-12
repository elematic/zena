# shellcheck shell=bash disable=SC2034
# The names of one environment of the App View, for the deploy scripts
# beside this file to source. PDS_ENV picks it: staging (the default, so a
# command run without thinking about it never touches production) or
# production. ZENA_GCP_PROJECT is the project; ZENA_GCP_REGION and
# ZENA_GCP_REPO default as the website's scripts do.
#
#   staging      the App View, its site and handles at
#                pkg-staging.zena-lang.dev, with its own PLC directory at
#                /plc (APP_VIEW_PLC=staging), so nothing it makes reaches
#                plc.directory; padstone, the PDS of its accounts, at
#                padstone-staging.zena-lang.dev
#   production   the App View, its site and handles at pkg.zena-lang.dev,
#                sending its accounts' operations to plc.directory;
#                padstone at padstone.zena-lang.dev
#
# Each name is a Cloud Run service of its own, both from one image
# (docs/design/package-manager.md, "Names and addresses"): the App View
# keeps its accounts on padstone, through com.atproto with its own tokens
# (APP_VIEW_PDS_URL). The two share the rest: a Firestore database, under
# one tenant, a bucket, a service account, secrets, a Cloud KMS key ring
# and a Cloud DNS zone. Everything an environment owns has its name, and
# staging's are production's with -staging after them.
#
# The App View's online rotation key (packages/pds/src/signer.zena) is in
# Cloud KMS for production, which signs with it and never lets it out.
# Staging keeps the secret its accounts were made with, since an App View
# whose key changed could no longer sign their operations; ZENA_ROTATION_KMS=1
# moves it to Cloud KMS too, for a staging whose data was reset. The App
# View's signing key, which its tokens to padstone are checked with, is in
# Cloud KMS in both: replacing it only changes the App View's DID document. The
# operator's offline rotation key, ranked above the online one, is
# ZENA_OFFLINE_ROTATION_KEY: its did:key, from
# `zena-cli run packages/registry/src/main.zena -- generate-key`, whose private
# key is kept offline. Production needs it. ZENA_ADMIN_DIDS lists the DIDs
# of the App View's admins, who see everything it holds in the web app,
# separated by spaces or commas.

PROJECT="${ZENA_GCP_PROJECT:?set ZENA_GCP_PROJECT to the project id, such as meta-garage-420114}"
REGION="${ZENA_GCP_REGION:-us-central1}"
REPO="${ZENA_GCP_REPO:-cloud-run-images}"
PDS_ENV="${PDS_ENV:-staging}"

case "$PDS_ENV" in
  staging)
    SUFFIX=-staging
    DOMAIN=pkg-staging.zena-lang.dev
    PDS_DOMAIN=padstone-staging.zena-lang.dev
    PLC_MODE=staging
    ROTATION_KMS="${ZENA_ROTATION_KMS:-0}"
    WEEKLY_BACKUPS=0
    SOFT_DELETE=7d
    ;;
  production)
    SUFFIX=
    DOMAIN=pkg.zena-lang.dev
    PDS_DOMAIN=padstone.zena-lang.dev
    PLC_MODE=public
    ROTATION_KMS=1
    WEEKLY_BACKUPS=1
    SOFT_DELETE=30d
    ;;
  *)
    echo "PDS_ENV is staging or production, not $PDS_ENV" >&2
    exit 2
    ;;
esac

# The image is the same for both environments.
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/zena-pkg"

# The App View's service keeps the name of the service that once ran both.
APP_VIEW_SERVICE="zena-pkg${SUFFIX}"
PDS_SERVICE="padstone${SUFFIX}"
# Firestore database IDs are 4 to 63 lowercase letters, digits and hyphens.
DATABASE="zena-pkg${SUFFIX}"
FIRESTORE_LOCATION="${ZENA_FIRESTORE_LOCATION:-$REGION}"
# Bucket names are global, so the project's id goes in front.
BUCKET="${PROJECT}-zena-pkg${SUFFIX}"
SERVICE_ACCOUNT="zena-pkg${SUFFIX}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT}.iam.gserviceaccount.com"
SECRET="zena-pkg${SUFFIX}-rotation-key"
# Signs the App View's web sessions. padstone, which serves no password
# sessions, has no secret; the name is from when it did.
JWT_SECRET="zena-pkg${SUFFIX}-jwt-secret"
# The smoke test's (smoke.sh): the scope of its canary package, and the
# secret that keeps the token of the automation account it publishes as.
SMOKE_SCOPE="${ZENA_SMOKE_SCOPE:-zena-lang}"
SMOKE_SECRET="zena-pkg${SUFFIX}-smoke-token"
# The online rotation key in Cloud KMS, when ROTATION_KMS is 1: an
# asymmetric secp256k1 key, at HSM protection, the only level Cloud KMS
# offers secp256k1 at.
KMS_LOCATION="${ZENA_KMS_LOCATION:-$REGION}"
KMS_KEYRING="zena-pkg${SUFFIX}"
KMS_KEY=rotation
KMS_KEY_VERSION="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}/cryptoKeyVersions/1"
# The App View's signing key, in the same key ring, made as the rotation key is.
SIGNING_KMS_KEY=signing
SIGNING_KMS_KEY_VERSION="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${SIGNING_KMS_KEY}/cryptoKeyVersions/1"
# The symmetric key in the same key ring that encrypts accounts' repository
# signing keys in Firestore (PDS_KEY_ENCRYPTION_KMS_KEY), in both
# environments.
SIGNING_KEYS_KMS_KEY=signing-keys
SIGNING_KEYS_KMS_NAME="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${SIGNING_KEYS_KMS_KEY}"
OFFLINE_ROTATION_KEY="${ZENA_OFFLINE_ROTATION_KEY:-}"
ADMIN_DIDS="${ZENA_ADMIN_DIDS:-}"
# The environment's own zone, delegated from zena-lang.dev's, so the
# service account can write handle records there and nowhere else. setup.sh
# writes the delegation when zena-lang.dev is a Cloud DNS zone, in the
# project or ZENA_DNS_PARENT_PROJECT (ZENA_DNS_PARENT_ZONE names it), and
# otherwise prints the NS records to add where its DNS is kept.
ZONE="zena-pkg${SUFFIX}"
# zena-lang.dev's own zone, which holds that delegation and the PDS's name,
# PDS_DOMAIN, which is beside DOMAIN rather than under it.
# find_parent_zone sets PARENT_ZONE to it: ZENA_DNS_PARENT_ZONE, or the
# zone in PARENT_PROJECT whose DNS name is exactly zena-lang.dev., rather
# than a --filter, whose matching of a dotted name depends on gcloud's
# filter rules. It is empty when zena-lang.dev's DNS is kept elsewhere,
# such as at the registrar. A function, so that sourcing this file runs no
# gcloud.
PARENT_PROJECT="${ZENA_DNS_PARENT_PROJECT:-$PROJECT}"
find_parent_zone() {
  PARENT_ZONE="${ZENA_DNS_PARENT_ZONE:-$(gcloud dns managed-zones list --project "$PARENT_PROJECT" \
    --format 'value(name,dnsName)' | awk '$2 == "zena-lang.dev." { print $1; exit }')}"
}
# Backups (setup.sh): point-in-time recovery of the database's last 7
# days and a daily backup kept 7 days in both environments; in production,
# WEEKLY_BACKUPS adds a weekly backup kept 14 weeks. A deleted blob stays
# recoverable from the bucket for SOFT_DELETE.
#
# The tenant within the database (docs/design/pds.md, "Accounts,
# organizations and tenants"). Each environment has a database of its own,
# so both use the same one.
TENANT=pkg

# The App View's configuration (registry/service), which deploy.sh gives
# its service and operator.sh the commands it runs here: APP_VIEW_VARS,
# its variables as NAME=value, and APP_VIEW_SECRETS, as NAME=<secret>, the
# Secret Manager secret each takes its value from.
APP_VIEW_VARS=(
  "APP_VIEW_DOMAIN=${DOMAIN}"
  "APP_VIEW_PDS_URL=https://${PDS_DOMAIN}"
  "APP_VIEW_STORAGE=firestore"
  "APP_VIEW_FIRESTORE_DATABASE=${DATABASE}"
  "APP_VIEW_TENANT=${TENANT}"
  # padstone's bucket, whose blobs are under ${TENANT}/<did>/ and the App
  # View's objects under ${TENANT}/app-view/.
  "APP_VIEW_BUCKET=${BUCKET}"
  "APP_VIEW_SIGNING_KMS_KEY=${SIGNING_KMS_KEY_VERSION}"
  "APP_VIEW_HANDLE_RECORDS=cloud-dns"
  "APP_VIEW_DNS_ZONE=${ZONE}"
  "APP_VIEW_DNS_PROJECT=${PROJECT}"
  "APP_VIEW_PLC=${PLC_MODE}"
  "GOOGLE_CLOUD_PROJECT=${PROJECT}"
)
APP_VIEW_SECRETS=("APP_VIEW_SESSION_SECRET=${JWT_SECRET}")
if [ "$ROTATION_KMS" = 1 ]; then
  APP_VIEW_VARS+=("APP_VIEW_ROTATION_KMS_KEY=${KMS_KEY_VERSION}")
else
  APP_VIEW_SECRETS+=("APP_VIEW_ROTATION_KEY=${SECRET}")
fi
if [ -n "$ADMIN_DIDS" ]; then
  # Spaces, since gcloud's --set-env-vars splits on commas.
  APP_VIEW_VARS+=("APP_VIEW_ADMIN_DIDS=${ADMIN_DIDS//,/ }")
fi
if [ -n "$OFFLINE_ROTATION_KEY" ]; then
  APP_VIEW_VARS+=("APP_VIEW_OFFLINE_ROTATION_KEY=${OFFLINE_ROTATION_KEY}")
fi

echo "environment: $PDS_ENV ($DOMAIN, the PDS at $PDS_DOMAIN)"
echo "project:     $PROJECT, $REGION"
echo
