#!/usr/bin/env bash
# Deploy the policy bundle keep-alive: Core rejects a /v1/bundle payload older
# than 72h, so it is re-signed daily and its public age is watched hourly.
#
#   policy-republisher        Cloud Run job, daily  — scripts/republish-policy-bundle.ts
#   policy-bundle-age-check   Cloud Run job, hourly — same image, --check --max-age-hours 48
#   alert policy              any failed execution of either job → email
#
#   EXPECTED_ACCOUNT=<you> ALERT_EMAIL=<addr> bash registryV2/scripts/deploy/deploy-policy-republisher.sh
#   ... RUN_NOW=1 bash ...    # also execute both jobs once after deploying
#
# Idempotent. Prerequisite (owner action, never done by this script): the
# signing key exists in Secret Manager as ${KEY_SECRET}. The job's service
# account gets read access to that one secret, list/read on the bucket, and
# write access limited to policy-bundles/ (IAM condition; bucket uses UBLA).
#
# **creates prod scheduling + alerting config.** Reversible:
#   gcloud scheduler jobs delete / gcloud run jobs delete / gcloud monitoring policies delete
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
rv3_activate_and_guard

ALERT_EMAIL="${ALERT_EMAIL:?set ALERT_EMAIL (alert notification address)}"
KEY_SECRET="${KEY_SECRET:-policy-signing-key-dev}"
JOB_SA_NAME="${JOB_SA_NAME:-policy-republisher-sa}"
JOB_SA="${JOB_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
REPUBLISH_JOB="${REPUBLISH_JOB:-policy-republisher}"
CHECK_JOB="${CHECK_JOB:-policy-bundle-age-check}"
REPUBLISH_SCHEDULE="${REPUBLISH_SCHEDULE:-0 3 * * *}"   # daily
CHECK_SCHEDULE="${CHECK_SCHEDULE:-17 * * * *}"          # hourly
SCHEDULE_TZ="${SCHEDULE_TZ:-Asia/Seoul}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-48}"
GIT_SHA="$(cd "${REPO_ROOT}" && git rev-parse --short HEAD 2>/dev/null || echo manual)"
# A tree with uncommitted changes must not borrow the clean commit's tag.
[[ -z "$(cd "${REPO_ROOT}" && git status --porcelain -- registryV2/scripts 2>/dev/null)" ]] || GIT_SHA="${GIT_SHA}-dirty"
IMAGE="${AR_LOCATION}-docker.pkg.dev/${PROJECT_ID}/dambi/policy-republisher:${IMAGE_TAG:-${GIT_SHA}}"
ALERT_NAME="policy bundle keep-alive failed"

echo "=== 1. APIs ==="
gcloud services enable cloudscheduler.googleapis.com --project "${PROJECT_ID}"

echo "=== 2. signing key secret ${KEY_SECRET} ==="
gcloud secrets describe "${KEY_SECRET}" --project "${PROJECT_ID}" >/dev/null \
  || { echo "ABORT: secret ${KEY_SECRET} missing — the owner uploads the key first" >&2; exit 1; }

echo "=== 3. service account ${JOB_SA} ==="
gcloud iam service-accounts describe "${JOB_SA}" --project "${PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${JOB_SA_NAME}" --project "${PROJECT_ID}" \
       --display-name="Policy bundle republisher (Cloud Run jobs)"
# A just-created service account takes a while to be visible to every IAM API.
retry() { local n; for n in 1 2 3 4 5 6; do "$@" && return 0; echo "  (retry ${n}: IAM not ready)"; sleep 10; done; return 1; }
retry gcloud secrets add-iam-policy-binding "${KEY_SECRET}" --project "${PROJECT_ID}" \
  --member="serviceAccount:${JOB_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
# list + read: highest <n>.json and latest.json generation
retry gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${JOB_SA}" --role=roles/storage.objectViewer >/dev/null
# create <n>.json, replace latest.json — only under policy-bundles/
retry gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${JOB_SA}" --role=roles/storage.objectUser \
  --condition="expression=resource.name.startsWith('projects/_/buckets/${BUCKET}/objects/policy-bundles/'),title=policy-bundles-only" >/dev/null

echo "=== 4. image ${IMAGE} ==="
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
mkdir -p "${STAGE}/scripts"
cp "${RV2_DIR}/package.json" "${RV2_DIR}/package-lock.json" "${RV2_DIR}/tsconfig.json" "${STAGE}/"
cp "${RV2_DIR}/scripts/republish-policy-bundle.ts" "${RV2_DIR}/scripts/publish-policy-bundle.ts" \
   "${RV2_DIR}/scripts/sign-bundles.ts" "${STAGE}/scripts/"
cp "${RV2_DIR}/scripts/deploy/policy-republisher/Dockerfile" "${STAGE}/Dockerfile"
gcloud builds submit "${STAGE}" --tag "${IMAGE}" --project "${PROJECT_ID}"

echo "=== 5. Cloud Run jobs ==="
gcloud run jobs deploy "${REPUBLISH_JOB}" --project "${PROJECT_ID}" --region "${REGION}" \
  --image "${IMAGE}" --service-account "${JOB_SA}" \
  --set-secrets "/secrets/policy-signing-key=${KEY_SECRET}:latest" \
  --set-env-vars "REGISTRY_BUCKET=${BUCKET},POLICY_SIGNING_KEY_PATH=/secrets/policy-signing-key" \
  --tasks 1 --max-retries 3 --task-timeout 300s --cpu 1 --memory 512Mi
gcloud run jobs deploy "${CHECK_JOB}" --project "${PROJECT_ID}" --region "${REGION}" \
  --image "${IMAGE}" --service-account "${JOB_SA}" \
  --args="--check,--max-age-hours,${MAX_AGE_HOURS}" \
  --tasks 1 --max-retries 1 --task-timeout 120s --cpu 1 --memory 512Mi
for job in "${REPUBLISH_JOB}" "${CHECK_JOB}"; do
  gcloud run jobs add-iam-policy-binding "${job}" --project "${PROJECT_ID}" --region "${REGION}" \
    --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker >/dev/null
done

echo "=== 6. Cloud Scheduler ==="
schedule() { # name job cron
  local verb=create
  gcloud scheduler jobs describe "$1" --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1 && verb=update
  gcloud scheduler jobs "${verb}" http "$1" --project "${PROJECT_ID}" --location "${REGION}" \
    --schedule "$3" --time-zone "${SCHEDULE_TZ}" --http-method POST \
    --uri "https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/$2:run" \
    --oauth-service-account-email "${JOB_SA}" >/dev/null
  echo "  $1 → $2 (${3} ${SCHEDULE_TZ})"
}
schedule "${REPUBLISH_JOB}-daily" "${REPUBLISH_JOB}" "${REPUBLISH_SCHEDULE}"
schedule "${CHECK_JOB}-hourly" "${CHECK_JOB}" "${CHECK_SCHEDULE}"

echo "=== 7. alerting → ${ALERT_EMAIL} ==="
# GA gcloud has no notification-channel commands; use the Monitoring REST API.
TOKEN="$(gcloud auth print-access-token)"
MON="https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}"
CHANNEL="$(curl -fsS -H "Authorization: Bearer ${TOKEN}" "${MON}/notificationChannels" \
  | ALERT_EMAIL="${ALERT_EMAIL}" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=(JSON.parse(s).notificationChannels||[]).find(c=>c.type==="email"&&c.labels?.email_address===process.env.ALERT_EMAIL);process.stdout.write(c?c.name:"")})')"
if [[ -z "${CHANNEL}" ]]; then
  CHANNEL="$(curl -fsS -X POST -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    "${MON}/notificationChannels" \
    -d "{\"type\":\"email\",\"displayName\":\"policy bundle keep-alive\",\"labels\":{\"email_address\":\"${ALERT_EMAIL}\"}}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name))')"
fi
echo "  channel ${CHANNEL}"
if gcloud monitoring policies list --project "${PROJECT_ID}" --filter="displayName=\"${ALERT_NAME}\"" \
     --format='value(name)' | grep -q .; then
  echo "  alert policy exists — left as-is"
else
  POLICY="$(mktemp)"
  cat > "${POLICY}" <<EOF
{
  "displayName": "${ALERT_NAME}",
  "documentation": {
    "content": "A ${REPUBLISH_JOB} (daily re-sign) or ${CHECK_JOB} (public /v1/bundle older than ${MAX_AGE_HOURS}h) execution failed. Core rejects bundles older than 72h. Re-sign manually: cd registryV2 && GCS_ACCESS_TOKEN=\$(gcloud auth print-access-token) npx tsx scripts/republish-policy-bundle.ts",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "conditions": [{
    "displayName": "failed job execution",
    "conditionThreshold": {
      "filter": "resource.type=\"cloud_run_job\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result=\"failed\" AND (resource.labels.job_name=\"${REPUBLISH_JOB}\" OR resource.labels.job_name=\"${CHECK_JOB}\")",
      "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM" }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 0,
      "duration": "0s"
    }
  }],
  "notificationChannels": ["${CHANNEL}"]
}
EOF
  gcloud monitoring policies create --project "${PROJECT_ID}" --policy-from-file "${POLICY}" >/dev/null
  rm -f "${POLICY}"
  echo "  alert policy created"
fi

if [[ "${RUN_NOW:-0}" == "1" ]]; then
  echo "=== RUN_NOW=1 ==="
  gcloud run jobs execute "${REPUBLISH_JOB}" --project "${PROJECT_ID}" --region "${REGION}" --wait
  gcloud run jobs execute "${CHECK_JOB}" --project "${PROJECT_ID}" --region "${REGION}" --wait
fi
echo "deploy-policy-republisher 완료."
