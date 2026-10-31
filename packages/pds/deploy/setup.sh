#!/usr/bin/env bash
#
# One-time Google Cloud setup for one environment of the package host
# (env.sh). Idempotent: safe to re-run, and re-running is the fix when a
# step failed part way. It never replaces a key once made: the rotation
# key, or the key that encrypts accounts' signing keys.
#
#   PDS_ENV=staging ZENA_GCP_PROJECT=meta-garage-420114 npm run deploy:setup -w @zena-lang/pds
#
# Then `npm run deploy` deploys the server, and `npm run deploy:domain`
# maps the domain to it, once.
#
# Every prompt is answered by a flag, since this runs under wireit, which
# gives gcloud no terminal to read an answer from.

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  dns.googleapis.com \
  secretmanager.googleapis.com \
  cloudkms.googleapis.com \
  iam.googleapis.com \
  --project "$PROJECT"

echo "==> Artifact Registry repository $REPO"
if gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists"
else
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" \
    --project "$PROJECT" --description 'Cloud Run images' --quiet
fi
# A build pushes as Cloud Build's account, not as you (see the website's
# scripts/gcp-setup.sh): grant whichever of the two it may be.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
for builder in "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"; do
  if gcloud iam service-accounts describe "$builder" --project "$PROJECT" > /dev/null 2>&1; then
    gcloud artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" --project "$PROJECT" \
      --member "serviceAccount:$builder" --role roles/artifactregistry.writer --quiet > /dev/null
    echo "    $builder may push"
  fi
done

echo "==> Service account $SERVICE_ACCOUNT_EMAIL"
if gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists"
else
  gcloud iam service-accounts create "$SERVICE_ACCOUNT" --project "$PROJECT" \
    --display-name "Zena package host ($PDS_ENV)" --quiet
fi
MEMBER="serviceAccount:$SERVICE_ACCOUNT_EMAIL"

echo "==> Firestore database $DATABASE ($FIRESTORE_LOCATION)"
if gcloud firestore databases describe --database "$DATABASE" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists"
else
  gcloud firestore databases create --database "$DATABASE" --location "$FIRESTORE_LOCATION" \
    --type firestore-native --project "$PROJECT" --quiet
fi
# Read and write this database and no other.
gcloud projects add-iam-policy-binding "$PROJECT" --member "$MEMBER" --role roles/datastore.user \
  --condition "expression=resource.name==\"projects/${PROJECT}/databases/${DATABASE}\",title=${DATABASE}-only" \
  --quiet > /dev/null
echo "    $SERVICE_ACCOUNT may use it"

echo "==> Bucket gs://$BUCKET"
if gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists"
else
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention --quiet
fi
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "$MEMBER" \
  --role roles/storage.objectAdmin --quiet > /dev/null
echo "    $SERVICE_ACCOUNT may use it"

echo "==> Cloud KMS key ring $KMS_KEYRING ($KMS_LOCATION)"
if gcloud kms keyrings describe "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists"
else
  gcloud kms keyrings create "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT" --quiet
fi

echo "==> Signing-key encryption key $SIGNING_KEYS_KMS_KEY"
if gcloud kms keys describe "$SIGNING_KEYS_KMS_KEY" --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" \
    --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists; left as it is"
else
  # Symmetric, so that Cloud KMS itself encrypts and decrypts accounts'
  # signing keys, and the key never leaves it. Destroying it loses every
  # signing key it encrypted.
  gcloud kms keys create "$SIGNING_KEYS_KMS_KEY" --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" \
    --project "$PROJECT" --purpose encryption --protection-level software --quiet
  echo "    made"
fi
gcloud kms keys add-iam-policy-binding "$SIGNING_KEYS_KMS_KEY" --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" \
  --project "$PROJECT" --member "$MEMBER" --role roles/cloudkms.cryptoKeyEncrypterDecrypter --quiet > /dev/null
echo "    $SERVICE_ACCOUNT may encrypt and decrypt with it"

if [ "$ROTATION_KMS" = 1 ]; then
  echo "==> Rotation key $KMS_KEY"
  if gcloud kms keys describe "$KMS_KEY" --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT" \
      > /dev/null 2>&1; then
    echo "    key exists; left as it is"
  else
    # It never leaves Cloud KMS, so it cannot be backed up: the offline
    # key, ranked above it, is what undoes its operations if it is lost
    # or misused.
    gcloud kms keys create "$KMS_KEY" --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" --project "$PROJECT" \
      --purpose asymmetric-signing --default-algorithm ec-sign-secp256k1-sha256 --protection-level hsm --quiet
    echo "    made"
  fi
  gcloud kms keys add-iam-policy-binding "$KMS_KEY" --keyring "$KMS_KEYRING" --location "$KMS_LOCATION" \
    --project "$PROJECT" --member "$MEMBER" --role roles/cloudkms.signerVerifier --quiet > /dev/null
  echo "    $SERVICE_ACCOUNT may sign with it"
fi

if [ "$ROTATION_KMS" != 1 ]; then
echo "==> Rotation key $SECRET"
if gcloud secrets describe "$SECRET" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists; left as it is"
else
  # 32 random bytes, a secp256k1 private key: below the curve's order but
  # for a chance of about 2^-128. It goes straight to Secret Manager and is
  # never written to disk.
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' | gcloud secrets create "$SECRET" --project "$PROJECT" \
    --replication-policy automatic --data-file - --quiet
  echo "    made; back it up somewhere safe: it signs every package account's PLC operations"
fi
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" --member "$MEMBER" \
  --role roles/secretmanager.secretAccessor --quiet > /dev/null
echo "    $SERVICE_ACCOUNT may read it"
fi

echo "==> Session secret $JWT_SECRET"
if gcloud secrets describe "$JWT_SECRET" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists; left as it is"
else
  # 32 random bytes, which sign the access and refresh tokens of sessions,
  # such as CI's. Replacing it signs every session out, and nothing else.
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' | gcloud secrets create "$JWT_SECRET" --project "$PROJECT" \
    --replication-policy automatic --data-file - --quiet
  echo "    made"
fi
gcloud secrets add-iam-policy-binding "$JWT_SECRET" --project "$PROJECT" --member "$MEMBER" \
  --role roles/secretmanager.secretAccessor --quiet > /dev/null
echo "    $SERVICE_ACCOUNT may read it"

echo "==> DNS zone $ZONE ($DOMAIN)"
if gcloud dns managed-zones describe "$ZONE" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    exists"
else
  gcloud dns managed-zones create "$ZONE" --project "$PROJECT" --dns-name "${DOMAIN}." \
    --description "Zena package host ($PDS_ENV): handle records" --quiet
fi
NAMESERVERS="$(gcloud dns managed-zones describe "$ZONE" --project "$PROJECT" \
  --format 'value(nameServers.list())' | tr ';' ',')"
# zena-lang.dev's zone delegates the domain to this one: NS records for
# the domain, naming this zone's nameservers. When that zone is a Cloud
# DNS zone, in this project or ZENA_DNS_PARENT_PROJECT, they are written
# here. When zena-lang.dev's DNS is elsewhere, such as at the registrar,
# they are printed for you to add there.
PARENT_PROJECT="${ZENA_DNS_PARENT_PROJECT:-$PROJECT}"
# Every zone's name and DNS name, and the one whose DNS name is exactly
# zena-lang.dev., rather than a --filter, whose matching of a dotted name
# depends on gcloud's filter rules.
PARENT_ZONE="${ZENA_DNS_PARENT_ZONE:-$(gcloud dns managed-zones list --project "$PARENT_PROJECT" \
  --format 'value(name,dnsName)' | awk '$2 == "zena-lang.dev." { print $1; exit }')}"
DELEGATE_BY_HAND=
if [ -z "$PARENT_ZONE" ]; then
  DELEGATE_BY_HAND=1
  echo "    zena-lang.dev. is not a Cloud DNS zone in $PARENT_PROJECT, so delegate ${DOMAIN} where"
  echo "    zena-lang.dev's DNS is kept, with these NS records (or set ZENA_DNS_PARENT_PROJECT"
  echo "    and ZENA_DNS_PARENT_ZONE, and run this again):"
  for ns in ${NAMESERVERS//,/ }; do
    echo "      ${DOMAIN}.  NS  ${ns}"
  done
elif gcloud dns record-sets describe "${DOMAIN}." --type NS --zone "$PARENT_ZONE" \
  --project "$PARENT_PROJECT" > /dev/null 2>&1; then
  echo "    delegated from $PARENT_ZONE"
else
  gcloud dns record-sets create "${DOMAIN}." --type NS --ttl 3600 --rrdatas "$NAMESERVERS" \
    --zone "$PARENT_ZONE" --project "$PARENT_PROJECT" --quiet > /dev/null
  echo "    delegated from $PARENT_ZONE to $NAMESERVERS"
fi
# Cloud DNS has no add-iam-policy-binding for a zone, only a whole policy.
# The zone is the environment's alone, so its policy is this one binding;
# roles granted on the project still apply above it.
POLICY="$(mktemp)"
trap 'rm -f "$POLICY"' EXIT
cat > "$POLICY" <<EOF
{"bindings": [{"role": "roles/dns.admin", "members": ["$MEMBER"]}]}
EOF
gcloud dns managed-zones set-iam-policy "$ZONE" --project "$PROJECT" --policy-file "$POLICY" --quiet > /dev/null
echo "    $SERVICE_ACCOUNT may write its records"

echo
if [ -n "$DELEGATE_BY_HAND" ]; then
  echo "Done, but for the NS records above. Once they are in, \`dig +short NS ${DOMAIN}\` lists them."
else
  echo "Done."
fi
echo "Next: npm run deploy -w @zena-lang/pds, with the same PDS_ENV."
