#!/bin/bash
set -e

PROJECT=igneous-aleph-468015-d8
REGION=northamerica-northeast1
REPO=octis
IMAGE=$REGION-docker.pkg.dev/$PROJECT/$REPO/octis
BUCKET=octis-build-$PROJECT

echo "=== Packaging source for Cloud Build ==="
cd /tmp/octis
tar czf /tmp/octis-source.tar.gz \
  --exclude=node_modules \
  --exclude=.git \
  --exclude='*.tar.gz' \
  .

echo "=== Uploading to GCS ==="
TOKEN=$(node -e "
const { GoogleAuth } = require('/usr/lib/node_modules/google-auth-library');
const auth = new GoogleAuth({ keyFile: '/root/.openclaw/workspace/gcp-keys/beatimo-claw-admin.json', scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
auth.getClient().then(c => c.getAccessToken()).then(t => process.stdout.write(t.token));
")

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/gzip" \
  --data-binary @/tmp/octis-source.tar.gz \
  "https://storage.googleapis.com/upload/storage/v1/b/$BUCKET/o?uploadType=media&name=octis-source.tar.gz" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Uploaded:', d.get('name','?'), 'size:', d.get('size','?'))"

echo "=== Triggering Cloud Build ==="
BUILD_BODY=$(cat <<EOF
{
  "source": {
    "storageSource": {
      "bucket": "$BUCKET",
      "object": "octis-source.tar.gz"
    }
  },
  "steps": [
    {
      "name": "gcr.io/cloud-builders/docker",
      "args": ["build", "-t", "$IMAGE:latest", "."]
    },
    {
      "name": "gcr.io/cloud-builders/docker",
      "args": ["push", "$IMAGE:latest"]
    }
  ],
  "options": { "logging": "CLOUD_LOGGING_ONLY" }
}
EOF
)

BUILD_RES=$(curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BUILD_BODY" \
  "https://cloudbuild.googleapis.com/v1/projects/$PROJECT/builds")

BUILD_ID=$(echo $BUILD_RES | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metadata',{}).get('build',{}).get('id','') or d.get('id','UNKNOWN'))")
echo "Build ID: $BUILD_ID"
echo "$BUILD_ID" > /tmp/octis_build_id.txt
echo "=== Build submitted. Poll for completion. ==="
