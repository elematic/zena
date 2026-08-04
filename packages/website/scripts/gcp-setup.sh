#!/usr/bin/env bash
#
# One-time Google Cloud setup for deploying the site. Idempotent: safe to
# re-run, and re-running is the fix if a deploy fails on permissions.
#
# Run it with `npm run deploy:setup -w @zena-lang/website`.
#
# The non-obvious part is the last step. `gcloud builds submit` pushes the image
# as Cloud Build's own service account, not as you, so your own access to the
# repository says nothing about whether a build can write to it. Without the
# grant below the build runs to completion and then fails at push with
# "Permission 'artifactregistry.repositories.uploadArtifacts' denied".

set -euo pipefail

PROJECT="${ZENA_GCP_PROJECT:?set ZENA_GCP_PROJECT to the Cloud Run project id}"
REGION="${ZENA_GCP_REGION:-us-central1}"
REPO="${ZENA_GCP_REPO:-cloud-run-images}"

echo "project: $PROJECT"
echo "region:  $REGION"
echo "repo:    $REPO"
echo

echo "==> Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project "$PROJECT"

echo "==> Artifact Registry repository"
if gcloud artifacts repositories describe "$REPO" \
  --location "$REGION" --project "$PROJECT" > /dev/null 2>&1; then
  echo "    $REPO already exists"
else
  gcloud artifacts repositories create "$REPO" \
    --repository-format docker \
    --location "$REGION" \
    --project "$PROJECT" \
    --description 'Cloud Run images'
  echo "    created $REPO"
fi

echo "==> Granting Cloud Build push access to $REPO"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

# Which account a build runs as depends on the age of the project and on org
# policy: Cloud Build used to default to its own service account and now
# defaults to the Compute Engine one. Grant whichever exist rather than
# guessing. The binding is on the repository, not the project, so this does not
# widen access to anything else.
granted=0
for sa in \
  "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"; do
  if gcloud iam service-accounts describe "$sa" --project "$PROJECT" > /dev/null 2>&1; then
    gcloud artifacts repositories add-iam-policy-binding "$REPO" \
      --location "$REGION" \
      --project "$PROJECT" \
      --member "serviceAccount:$sa" \
      --role roles/artifactregistry.writer > /dev/null
    echo "    granted artifactregistry.writer to $sa"
    granted=$((granted + 1))
  fi
done

if [ "$granted" -eq 0 ]; then
  echo
  echo "WARNING: found neither default Cloud Build service account." >&2
  echo "Find the one your build actually used and grant it by hand:" >&2
  echo >&2
  echo "  BUILD=\$(gcloud builds list --limit=1 --project=$PROJECT --format='value(id)')" >&2
  echo "  gcloud builds describe \$BUILD --project=$PROJECT --format='value(serviceAccount)'" >&2
  echo >&2
  echo "  gcloud artifacts repositories add-iam-policy-binding $REPO \\" >&2
  echo "    --location=$REGION --project=$PROJECT \\" >&2
  echo "    --member=serviceAccount:<THE-ACCOUNT> --role=roles/artifactregistry.writer" >&2
  exit 1
fi

echo
echo "Setup complete. Next: npm run deploy -w @zena-lang/website"
