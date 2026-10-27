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
# Firestore database, a bucket, a service account, a secret and a Cloud DNS
# zone. Staging's are production's with -staging after them.

PROJECT="${ZENA_GCP_PROJECT:?set ZENA_GCP_PROJECT to the project id, such as meta-garage-420114}"
REGION="${ZENA_GCP_REGION:-us-central1}"
REPO="${ZENA_GCP_REPO:-cloud-run-images}"
PDS_ENV="${PDS_ENV:-staging}"

case "$PDS_ENV" in
  staging)
    SUFFIX=-staging
    DOMAIN=pkg-staging.zena-lang.dev
    PLC_MODE=staging
    ;;
  production)
    SUFFIX=
    DOMAIN=pkg.zena-lang.dev
    PLC_MODE=public
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
