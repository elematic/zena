# shellcheck shell=bash disable=SC2034
# Production's settings, which env.sh reads for PDS_ENV=production. Public
# values only: secrets are in Secret Manager and keys in Cloud KMS, under
# the names env.sh derives, and none of their values belongs here. A
# change is a pull request, deployed from main.

PROJECT=meta-garage-420114
REGION=us-central1
# The Artifact Registry repository the image is pushed to.
REPO=cloud-run-images
FIRESTORE_LOCATION=us-central1
KMS_LOCATION=us-central1

# The App View, its site and its handles.
DOMAIN=pkg.zena-lang.dev
# padstone, the PDS of its accounts.
PDS_DOMAIN=padstone.zena-lang.dev
# public: the App View sends its accounts' operations to plc.directory.
PLC_MODE=public

# The App View's online rotation key is in Cloud KMS, which signs with it
# and never lets it out. Production is always 1.
ROTATION_KMS=1
# The operator's offline rotation key, as a did:key, ranked above the
# online one on every account. Its private key is kept offline by the
# operator, never on a server or in this repository. Production refuses to
# deploy without it.
OFFLINE_ROTATION_KEY=did:key:zQ3shu3F6uBcRXCtsx7EnA1tn3UqkQnTFLkQKz7zyFsJmLKVK
# The App View's admins, separated by spaces: they see everything it holds
# in the web app.
ADMIN_DIDS=did:plc:ec64xv7n5dszeizw56yr6b5h

# Backups (setup.sh): 1 adds a weekly backup kept 14 weeks to the daily ones.
WEEKLY_BACKUPS=1
# How long a deleted blob stays recoverable from the bucket.
SOFT_DELETE=30d

# The scope of the smoke test's canary package (smoke.sh).
SMOKE_SCOPE=zena-lang

# zena-lang.dev's Cloud DNS zone and its project, where setup.sh delegates
# DOMAIN and domain.sh points PDS_DOMAIN. Empty while zena-lang.dev's DNS is
# at the registrar: the scripts then print the records to add there.
DNS_PARENT_PROJECT=
DNS_PARENT_ZONE=
