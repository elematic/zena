# shellcheck shell=bash disable=SC2034
# The names of one environment of the App View, for the deploy scripts
# beside this file to source. PDS_ENV picks it: staging (the default, so a
# command run without thinking about it never touches production) or
# production. Its settings are checked in, in the operator's private
# repository, which ZENA_DEPLOY_SETTINGS names a directory of: staging.sh
# and production.sh, shaped as environments/example.sh is: the project,
# the domains, the PLC mode, where the rotation key is, the offline key's
# did:key and the admins. Nothing else is read from the shell, so every
# operator's deploy is the same, and changing production is a pull request
# there. A ZENA_* variable that the settings once came from is refused when
# it disagrees with the file, rather than ignored.
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
# Cloud KMS when ROTATION_KMS is 1, which signs with it and never lets it
# out, and otherwise a Secret Manager secret. The App View's signing key,
# which its tokens to padstone are checked with, is in Cloud KMS in both:
# replacing it only changes the App View's DID document. The operator's
# offline rotation keys, ranked above the online one, are
# OFFLINE_ROTATION_KEYS: their did:keys, each from
# `zena-cli run packages/registry/src/main.zena -- generate-key`, whose
# private keys are kept offline, apart. Production needs two, so that
# losing one leaves the other.

PDS_ENV="${PDS_ENV:-staging}"
case "$PDS_ENV" in
  staging) SUFFIX=-staging ;;
  production) SUFFIX= ;;
  *)
    echo "PDS_ENV is staging or production, not $PDS_ENV" >&2
    exit 2
    ;;
esac
SETTINGS="${ZENA_DEPLOY_SETTINGS:?set ZENA_DEPLOY_SETTINGS to the directory of staging.sh and production.sh, a checkout of the private deploy repository}/${PDS_ENV}.sh"
if [ ! -f "$SETTINGS" ]; then
  echo "$SETTINGS does not exist: ZENA_DEPLOY_SETTINGS names a directory with staging.sh and production.sh in it" >&2
  exit 2
fi
# shellcheck source=environments/example.sh
source "$SETTINGS"

# Every setting the scripts need, which an empty one would change silently.
for name in PROJECT REGION REPO FIRESTORE_LOCATION KMS_LOCATION DOMAIN PDS_DOMAIN PLC_MODE ROTATION_KMS \
    ADMIN_DIDS SCOPE_CREATORS WEEKLY_BACKUPS SOFT_DELETE SMOKE_SCOPE; do
  if [ -z "${!name:-}" ]; then
    echo "$SETTINGS sets no $name" >&2
    exit 2
  fi
done
OFFLINE_ROTATION_KEYS="${OFFLINE_ROTATION_KEYS:-}"
# shellcheck disable=SC2086 # split into its did:keys
OFFLINE_COUNT="$(set -- ${OFFLINE_ROTATION_KEYS//,/ } && echo $#)"
if [ "$PDS_ENV" = production ] && { [ "$OFFLINE_COUNT" != 2 ] || [ "$ROTATION_KMS" != 1 ] ||
    [ "$PLC_MODE" != public ]; }; then
  echo "$SETTINGS: production needs two OFFLINE_ROTATION_KEYS, ROTATION_KMS=1 and PLC_MODE=public" >&2
  exit 2
fi
# The variables these settings were once read from: one still set in the
# shell is a mistake when it says something else.
for pair in ZENA_GCP_PROJECT=PROJECT ZENA_GCP_REGION=REGION ZENA_GCP_REPO=REPO \
    ZENA_FIRESTORE_LOCATION=FIRESTORE_LOCATION ZENA_KMS_LOCATION=KMS_LOCATION ZENA_ROTATION_KMS=ROTATION_KMS \
    ZENA_OFFLINE_ROTATION_KEY=OFFLINE_ROTATION_KEYS ZENA_ADMIN_DIDS=ADMIN_DIDS ZENA_SMOKE_SCOPE=SMOKE_SCOPE \
    ZENA_DNS_PARENT_PROJECT=DNS_PARENT_PROJECT ZENA_DNS_PARENT_ZONE=DNS_PARENT_ZONE; do
  old="${pair%%=*}"
  setting="${pair#*=}"
  if [ -n "${!old:-}" ] && [ "${!old}" != "${!setting}" ]; then
    echo "$old is ${!old}, but $SETTINGS sets $setting to ${!setting:-nothing}: unset $old, or change the file" >&2
    exit 2
  fi
done

# The image is the same for both environments.
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/zena-pkg"

# The App View's service keeps the name of the service that once ran both.
APP_VIEW_SERVICE="zena-pkg${SUFFIX}"
PDS_SERVICE="padstone${SUFFIX}"
# Firestore database IDs are 4 to 63 lowercase letters, digits and hyphens.
DATABASE="zena-pkg${SUFFIX}"
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
SMOKE_SECRET="zena-pkg${SUFFIX}-smoke-token"
# The online rotation key in Cloud KMS, when ROTATION_KMS is 1: an
# asymmetric secp256k1 key, at HSM protection, the only level Cloud KMS
# offers secp256k1 at.
KMS_KEYRING="zena-pkg${SUFFIX}"
KMS_KEY=rotation
# The rotation key's version the App View signs with: 1 until it is
# replaced (DEVELOPMENT.md, "Rotation keys").
KMS_KEY_VERSION="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}/cryptoKeyVersions/${ROTATION_KMS_VERSION:-1}"
# The App View's signing key, in the same key ring, made as the rotation key is.
SIGNING_KMS_KEY=signing
SIGNING_KMS_KEY_VERSION="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${SIGNING_KMS_KEY}/cryptoKeyVersions/1"
# The symmetric key in the same key ring that encrypts accounts' repository
# signing keys in Firestore (PDS_KEY_ENCRYPTION_KMS_KEY), in both
# environments.
SIGNING_KEYS_KMS_KEY=signing-keys
SIGNING_KEYS_KMS_NAME="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${SIGNING_KEYS_KMS_KEY}"
# The environment's own zone, delegated from zena-lang.dev's, so the
# service account can write handle records there and nowhere else. setup.sh
# writes the delegation when zena-lang.dev is a Cloud DNS zone, in the
# project or DNS_PARENT_PROJECT (DNS_PARENT_ZONE names it), and otherwise
# prints the NS records to add where its DNS is kept.
ZONE="zena-pkg${SUFFIX}"
# zena-lang.dev's own zone, which holds that delegation and the PDS's name,
# PDS_DOMAIN, which is beside DOMAIN rather than under it.
# find_parent_zone sets PARENT_ZONE to it: DNS_PARENT_ZONE, or the
# zone in PARENT_PROJECT whose DNS name is exactly zena-lang.dev., rather
# than a --filter, whose matching of a dotted name depends on gcloud's
# filter rules. It is empty when zena-lang.dev's DNS is kept elsewhere,
# such as at the registrar. A function, so that sourcing this file runs no
# gcloud.
PARENT_PROJECT="${DNS_PARENT_PROJECT:-$PROJECT}"
find_parent_zone() {
  PARENT_ZONE="${DNS_PARENT_ZONE:-$(gcloud dns managed-zones list --project "$PARENT_PROJECT" \
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
  "APP_VIEW_SCOPE_CREATORS=${SCOPE_CREATORS}"
  "GOOGLE_CLOUD_PROJECT=${PROJECT}"
)
APP_VIEW_SECRETS=("APP_VIEW_SESSION_SECRET=${JWT_SECRET}")
if [ "$ROTATION_KMS" = 1 ]; then
  APP_VIEW_VARS+=("APP_VIEW_ROTATION_KMS_KEY=${KMS_KEY_VERSION}")
else
  APP_VIEW_SECRETS+=("APP_VIEW_ROTATION_KEY=${SECRET}")
fi
# Spaces, since gcloud's --set-env-vars splits on commas.
APP_VIEW_VARS+=("APP_VIEW_ADMIN_DIDS=${ADMIN_DIDS//,/ }")
if [ -n "$OFFLINE_ROTATION_KEYS" ]; then
  APP_VIEW_VARS+=("APP_VIEW_OFFLINE_ROTATION_KEYS=${OFFLINE_ROTATION_KEYS//,/ }")
fi

# Exports what registry/main needs to run on this machine as the
# environment's service (operator.sh, restore-drill.sh): each NAME=value of
# its arguments, the App View's secrets (APP_VIEW_SECRETS) from Secret
# Manager, and an access token of its service account, which deploy:setup
# lets the account that ran it act as. Exported, so that no secret is on a
# command line. The token lasts an hour.
export_service_environment() {
  local pair
  for pair in "$@"; do
    export "${pair?}"
  done
  for pair in "${APP_VIEW_SECRETS[@]}"; do
    export "${pair%%=*}=$(gcloud secrets versions access latest --secret "${pair#*=}" --project "$PROJECT")"
  done
  GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token --impersonate-service-account "$SERVICE_ACCOUNT_EMAIL" \
    2> /dev/null)" || {
    echo "gcloud could not act as $SERVICE_ACCOUNT_EMAIL: run npm run deploy:setup -w @zena-lang/registry," >&2
    echo "which lets the account it runs as do so (roles/iam.serviceAccountTokenCreator)" >&2
    return 2
  }
  export GOOGLE_OAUTH_ACCESS_TOKEN
}

echo "environment: $PDS_ENV ($DOMAIN, the PDS at $PDS_DOMAIN)"
echo "project:     $PROJECT, $REGION"
echo
