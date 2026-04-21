#!/usr/bin/env bash
# Manual MongoDB backup to Cloudflare R2
# Usage: MONGO_URI="..." R2_ACCOUNT_ID="..." R2_ACCESS_KEY_ID="..." R2_SECRET_ACCESS_KEY="..." bash scripts/backup.sh

set -euo pipefail

: "${MONGO_URI:?MONGO_URI is required}"
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${AWS_ACCESS_KEY_ID:=${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}}"
: "${AWS_SECRET_ACCESS_KEY:=${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}}"

BUCKET="qualifresh-backups"
FOLDER="qualifresh-$(date +%Y-%m)"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
TMP_DIR="/tmp"

echo "==> Starting backup: $FOLDER"

# Step 1: Dump
echo "==> Running mongodump..."
mongodump \
  --uri="$MONGO_URI" \
  --out="${TMP_DIR}/${FOLDER}" \
  --gzip

echo "==> Dump complete:"
ls -lh "${TMP_DIR}/${FOLDER}"

# Step 2: Compress
echo "==> Compressing..."
tar -czf "${TMP_DIR}/${FOLDER}.tar.gz" -C "$TMP_DIR" "$FOLDER"
echo "==> Archive: $(du -sh ${TMP_DIR}/${FOLDER}.tar.gz | cut -f1)"

# Step 3: Upload
echo "==> Uploading to R2: ${BUCKET}/${FOLDER}/"
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
aws s3 cp \
  "${TMP_DIR}/${FOLDER}.tar.gz" \
  "s3://${BUCKET}/${FOLDER}/${FOLDER}.tar.gz" \
  --endpoint-url "$ENDPOINT" \
  --region auto

echo "==> Verifying..."
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
aws s3 ls "s3://${BUCKET}/${FOLDER}/" \
  --endpoint-url "$ENDPOINT" \
  --region auto

# Step 4: Clean up
rm -rf "${TMP_DIR}/${FOLDER}" "${TMP_DIR}/${FOLDER}.tar.gz"
echo "==> Done! Backup stored at: ${BUCKET}/${FOLDER}/${FOLDER}.tar.gz"
