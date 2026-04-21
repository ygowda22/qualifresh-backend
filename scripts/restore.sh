#!/usr/bin/env bash
# Restore MongoDB from a Cloudflare R2 backup
# Usage: MONGO_URI="..." R2_ACCOUNT_ID="..." R2_ACCESS_KEY_ID="..." R2_SECRET_ACCESS_KEY="..." bash scripts/restore.sh qualifresh-2026-04

set -euo pipefail

: "${MONGO_URI:?MONGO_URI is required}"
: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${AWS_ACCESS_KEY_ID:=${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID is required}}"
: "${AWS_SECRET_ACCESS_KEY:=${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY is required}}"

FOLDER="${1:?Usage: $0 <backup-folder-name e.g. qualifresh-2026-04>}"
BUCKET="qualifresh-backups"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
TMP_DIR="/tmp"

echo "==> Restoring from backup: $FOLDER"

# Step 1: Download
echo "==> Downloading ${FOLDER}.tar.gz from R2..."
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
aws s3 cp \
  "s3://${BUCKET}/${FOLDER}/${FOLDER}.tar.gz" \
  "${TMP_DIR}/${FOLDER}.tar.gz" \
  --endpoint-url "$ENDPOINT" \
  --region auto

# Step 2: Extract
echo "==> Extracting..."
tar -xzf "${TMP_DIR}/${FOLDER}.tar.gz" -C "$TMP_DIR"

# Step 3: Restore
echo "==> Running mongorestore..."
mongorestore \
  --uri="$MONGO_URI" \
  --dir="${TMP_DIR}/${FOLDER}" \
  --gzip \
  --drop

# Step 4: Clean up
rm -rf "${TMP_DIR}/${FOLDER}" "${TMP_DIR}/${FOLDER}.tar.gz"
echo "==> Restore complete from backup: $FOLDER"
