# shellcheck shell=bash disable=SC2034
# The shape of an environment's settings, which env.sh reads from
# $ZENA_DEPLOY_SETTINGS/<PDS_ENV>.sh: staging.sh and production.sh, kept in
# the operator's private repository rather than here, so that this public
# one does not name the project or the admins. They hold public values
# only: secrets are in Secret Manager and keys in Cloud KMS, under the names
# env.sh derives, and none of their values belongs in either repository.
# A change to them is a pull request there, deployed from its main.
#
# Copy this file to start one. The values below are placeholders.

# The Google Cloud project.
PROJECT=example-project
REGION=us-central1
# The Artifact Registry repository the image is pushed to.
REPO=cloud-run-images
FIRESTORE_LOCATION=us-central1
KMS_LOCATION=us-central1

# The App View, its site and its handles.
DOMAIN=pkg-staging.example.dev
# padstone, the PDS of its accounts.
PDS_DOMAIN=padstone-staging.example.dev
# staging: the App View is a PLC directory itself, at https://$DOMAIN/plc,
# so nothing it makes reaches plc.directory. public: it sends its
# accounts' operations to plc.directory. Production must be public.
PLC_MODE=staging

# 1: the App View's online rotation key is in Cloud KMS, which signs with
# it and never lets it out. 0: it is a Secret Manager secret, which only a
# staging may use. Changing it makes the App View unable to sign its
# existing accounts' operations, so it takes a reset (DEVELOPMENT.md,
# "Resetting staging"), whose deploy:setup makes the KMS key. Production
# must be 1.
ROTATION_KMS=1
# The operator's offline rotation key, as a did:key, ranked above the
# online one on every account, from
# `zena-cli run packages/registry/src/main.zena -- generate-key` on a
# machine the operator trusts. Its private key is kept offline, never on a
# server or in a repository. Production must have one; a staging, whose
# accounts are reset, may leave it empty.
OFFLINE_ROTATION_KEY=
# The App View's admins, separated by spaces: they see everything it holds
# in the web app.
ADMIN_DIDS=did:plc:exampleexampleexampleex

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
