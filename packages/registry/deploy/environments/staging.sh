# shellcheck shell=bash disable=SC2034
# Staging's settings, which env.sh reads for PDS_ENV=staging. Public
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
DOMAIN=pkg-staging.zena-lang.dev
# padstone, the PDS of its accounts.
PDS_DOMAIN=padstone-staging.zena-lang.dev
# staging: the App View is a PLC directory itself, at https://$DOMAIN/plc,
# so nothing staging makes reaches plc.directory.
PLC_MODE=staging

# 1: the App View's online rotation key is in Cloud KMS, as production's
# is. 0: it is the Secret Manager secret staging's first accounts were
# made with. Changing it makes the App View unable to sign its existing
# accounts' operations, so it takes a reset (DEVELOPMENT.md, "Resetting
# staging"), whose deploy:setup makes the KMS key.
ROTATION_KMS=1
# The operator's offline rotation key, as a did:key, ranked above the
# online one. Staging's accounts are in its own directory and are reset,
# so it has none; the private key stays out of drills.
OFFLINE_ROTATION_KEY=
# The App View's admins, separated by spaces: they see everything it holds
# in the web app.
ADMIN_DIDS=did:plc:ec64xv7n5dszeizw56yr6b5h

# Backups (setup.sh): 1 adds a weekly backup kept 14 weeks to the daily ones.
WEEKLY_BACKUPS=0
# How long a deleted blob stays recoverable from the bucket.
SOFT_DELETE=7d

# The scope of the smoke test's canary package (smoke.sh).
SMOKE_SCOPE=zena-lang

# zena-lang.dev's Cloud DNS zone and its project, where setup.sh delegates
# DOMAIN and domain.sh points PDS_DOMAIN. Empty while zena-lang.dev's DNS is
# at the registrar: the scripts then print the records to add there.
DNS_PARENT_PROJECT=
DNS_PARENT_ZONE=
