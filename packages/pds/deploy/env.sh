# shellcheck shell=bash disable=SC2034
# The names of one environment of the package host, for the deploy scripts
# beside this file to source. PDS_ENV picks it: staging (the default, so a
# command run without thinking about it never touches production) or
# production. ZENA_GCP_PROJECT is the project; ZENA_GCP_REGION and
# ZENA_GCP_REPO default as the website's scripts do.
#
#   staging      pkg-staging.zena-lang.dev, with its own PLC directory at
#                /plc (PDS_PLC=staging), so nothing it makes reaches
#                plc.directory
#   production   pkg.zena-lang.dev, sending its accounts' operations to
#                plc.directory
#
# Everything an environment owns has its name: a Cloud Run service, a
# Firestore database, a bucket, a service account, secrets, a Cloud KMS
# key ring, and a Cloud DNS zone. Staging's are production's with -staging
# after them.
#
# The host's online rotation key (packages/pds/zena/rotation.zena) is in
# Cloud KMS for production, which signs with it and never lets it out.
# Staging keeps the secret its accounts were made with, since a host whose
# key changed could no longer sign their operations; ZENA_ROTATION_KMS=1
# moves it to Cloud KMS too, for a staging whose data was reset. The
# operator's offline rotation key, ranked above the online one, is
# ZENA_OFFLINE_ROTATION_KEY: its did:key, from
# `zena-cli run packages/pds/zena/main.zena -- generate-key`, whose private
# key is kept offline. Production needs it. ZENA_ADMIN_DIDS lists the DIDs
# of the host's admins, who see everything it holds in the web app,
# separated by spaces or commas.

PROJECT="${ZENA_GCP_PROJECT:?set ZENA_GCP_PROJECT to the project id, such as meta-garage-420114}"
REGION="${ZENA_GCP_REGION:-us-central1}"
REPO="${ZENA_GCP_REPO:-cloud-run-images}"
PDS_ENV="${PDS_ENV:-staging}"

case "$PDS_ENV" in
  staging)
    SUFFIX=-staging
    DOMAIN=pkg-staging.zena-lang.dev
    PLC_MODE=staging
    ROTATION_KMS="${ZENA_ROTATION_KMS:-0}"
    ;;
  production)
    SUFFIX=
    DOMAIN=pkg.zena-lang.dev
    PLC_MODE=public
    ROTATION_KMS=1
    ;;
  *)
    echo "PDS_ENV is staging or production, not $PDS_ENV" >&2
    exit 2
    ;;
esac

# The image is the same for both environments.
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/zena-pkg"

SERVICE="zena-pkg${SUFFIX}"
# Firestore database IDs are 4 to 63 lowercase letters, digits and hyphens.
DATABASE="zena-pkg${SUFFIX}"
FIRESTORE_LOCATION="${ZENA_FIRESTORE_LOCATION:-$REGION}"
# Bucket names are global, so the project's id goes in front.
BUCKET="${PROJECT}-zena-pkg${SUFFIX}"
SERVICE_ACCOUNT="zena-pkg${SUFFIX}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT}.iam.gserviceaccount.com"
SECRET="zena-pkg${SUFFIX}-rotation-key"
JWT_SECRET="zena-pkg${SUFFIX}-jwt-secret"
# The online rotation key in Cloud KMS, when ROTATION_KMS is 1: an
# asymmetric secp256k1 key, at HSM protection, the only level Cloud KMS
# offers secp256k1 at.
KMS_LOCATION="${ZENA_KMS_LOCATION:-$REGION}"
KMS_KEYRING="zena-pkg${SUFFIX}"
KMS_KEY=rotation
KMS_KEY_VERSION="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KMS_KEYRING}/cryptoKeys/${KMS_KEY}/cryptoKeyVersions/1"
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
# The tenant within the database (docs/design/pds.md, "Accounts,
# organizations and tenants"). Each environment has a database of its own,
# so both use the same one.
TENANT=pkg

echo "environment: $PDS_ENV ($DOMAIN)"
echo "project:     $PROJECT, $REGION"
echo
