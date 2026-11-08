#!/usr/bin/env bash
#
# Watches one environment (env.sh) once both its names answer, after
# deploy:domain: an uptime check on each name, and alerts, sent by email to
# ZENA_ALERT_EMAIL, when two of a check's regions fail it or a service
# answers with server errors. With ZENA_MONTHLY_BUDGET, in US dollars, it
# also sets a monthly budget on the project, which the website shares,
# that warns at half, nine tenths and all of it. Re-running it adds only
# what is missing; to change a check or an alert, delete it in the console
# and run this again.
#
#   PDS_ENV=staging ZENA_GCP_PROJECT=meta-garage-420114 ZENA_ALERT_EMAIL=you@example.com \
#     npm run deploy:alerts -w @zena-lang/registry
#
# Needs gcloud's beta component, for the email channel.

set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=env.sh
source ./env.sh

EMAIL="${ZENA_ALERT_EMAIL:?set ZENA_ALERT_EMAIL to the address alerts go to}"
BUDGET="${ZENA_MONTHLY_BUDGET:-}"

POLICY="$(mktemp)"
trap 'rm -f "$POLICY"' EXIT

echo "==> Email channel for $EMAIL"
CHANNEL="$(gcloud beta monitoring channels list --project "$PROJECT" \
  --filter "type=\"email\" AND labels.email_address=\"$EMAIL\"" --format 'value(name)' | head -n 1)"
if [ -n "$CHANNEL" ]; then
  echo "    exists"
else
  CHANNEL="$(gcloud beta monitoring channels create --project "$PROJECT" --type email \
    --display-name "Zena registry: $EMAIL" --channel-labels "email_address=$EMAIL" --format 'value(name)')"
  echo "    made"
fi

# Sets CHECK to the ID of the uptime check of the name $1, making it if
# need be: an HTTPS request for /xrpc/_health, which both services answer,
# every 5 minutes from three regions.
uptime_check() {
  local name="$1" display="Zena registry $PDS_ENV: $1" config
  echo "==> Uptime check of $name"
  config="$(gcloud monitoring uptime list-configs --project "$PROJECT" --filter "displayName=\"$display\"" \
    --format 'value(name)' | head -n 1)"
  if [ -n "$config" ]; then
    echo "    exists"
  else
    config="$(gcloud monitoring uptime create "$display" --project "$PROJECT" --resource-type uptime-url \
      --resource-labels "host=$name,project_id=$PROJECT" --protocol https --path /xrpc/_health \
      --period 5 --timeout 30 --regions usa-iowa,usa-virginia,europe --format 'value(name)')"
    echo "    made"
  fi
  CHECK="${config##*/}"
}
uptime_check "$DOMAIN"
APP_VIEW_CHECK="$CHECK"
uptime_check "$PDS_DOMAIN"
PDS_CHECK="$CHECK"

# Makes the alert policy named $1 from the JSON in $POLICY, unless one of
# that name exists.
policy() {
  local display="$1"
  echo "==> Alert: $display"
  if [ -n "$(gcloud monitoring policies list --project "$PROJECT" --filter "displayName=\"$display\"" \
    --format 'value(name)')" ]; then
    echo "    exists"
  else
    gcloud monitoring policies create --project "$PROJECT" --policy-from-file "$POLICY" --quiet > /dev/null
    echo "    made, emailing $EMAIL"
  fi
}

# One condition per check: more than one of its three regions failing it.
uptime_condition() {
  cat << EOF
{
  "displayName": "$1 fails its uptime check",
  "conditionThreshold": {
    "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"$2\"",
    "aggregations": [{
      "alignmentPeriod": "1200s",
      "perSeriesAligner": "ALIGN_NEXT_OLDER",
      "crossSeriesReducer": "REDUCE_COUNT_FALSE",
      "groupByFields": ["resource.label.*"]
    }],
    "comparison": "COMPARISON_GT",
    "thresholdValue": 1,
    "duration": "60s",
    "trigger": {"count": 1}
  }
}
EOF
}
UPTIME_POLICY="Zena registry $PDS_ENV: a name does not answer"
cat > "$POLICY" << EOF
{
  "displayName": "$UPTIME_POLICY",
  "combiner": "OR",
  "conditions": [$(uptime_condition "$DOMAIN" "$APP_VIEW_CHECK"), $(uptime_condition "$PDS_DOMAIN" "$PDS_CHECK")],
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "content": "An uptime check of $PDS_ENV fails. See the runbook's \"A name that does not answer\".",
    "mimeType": "text/markdown"
  }
}
EOF
policy "$UPTIME_POLICY"

# One condition per service: more than 4 responses of status 5xx in 5 minutes.
errors_condition() {
  cat << EOF
{
  "displayName": "$1 answers with server errors",
  "conditionThreshold": {
    "filter": "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"$1\" AND metric.label.response_code_class=\"5xx\"",
    "aggregations": [{
      "alignmentPeriod": "300s",
      "perSeriesAligner": "ALIGN_DELTA",
      "crossSeriesReducer": "REDUCE_SUM",
      "groupByFields": ["resource.label.service_name"]
    }],
    "comparison": "COMPARISON_GT",
    "thresholdValue": 4,
    "duration": "0s",
    "trigger": {"count": 1}
  }
}
EOF
}
ERRORS_POLICY="Zena registry $PDS_ENV: server errors"
cat > "$POLICY" << EOF
{
  "displayName": "$ERRORS_POLICY",
  "combiner": "OR",
  "conditions": [$(errors_condition "$APP_VIEW_SERVICE"), $(errors_condition "$PDS_SERVICE")],
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "content": "A service of $PDS_ENV answered more than 4 requests with 5xx in 5 minutes. Its logs: gcloud run services logs read <service> --region $REGION --project $PROJECT",
    "mimeType": "text/markdown"
  }
}
EOF
policy "$ERRORS_POLICY"

if [ -n "$BUDGET" ]; then
  echo "==> Monthly budget of \$$BUDGET for $PROJECT"
  gcloud services enable billingbudgets.googleapis.com --project "$PROJECT"
  ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format 'value(billingAccountName)')"
  ACCOUNT="${ACCOUNT##*/}"
  BUDGET_NAME="$PROJECT, monthly"
  if [ -n "$(gcloud billing budgets list --billing-account "$ACCOUNT" --filter "displayName=\"$BUDGET_NAME\"" \
    --format 'value(name)')" ]; then
    echo "    exists"
  else
    gcloud billing budgets create --billing-account "$ACCOUNT" --display-name "$BUDGET_NAME" \
      --budget-amount "${BUDGET}USD" --filter-projects "projects/$PROJECT" \
      --threshold-rule percent=0.5 --threshold-rule percent=0.9 --threshold-rule percent=1.0 \
      --notifications-rule-monitoring-notification-channels "$CHANNEL" --quiet > /dev/null
    echo "    made: warns at 50%, 90% and 100%, by email to $EMAIL and the billing account's admins"
  fi
fi

echo
echo "Done. The checks and alerts are in the console under Monitoring, Uptime checks and Alerting."
