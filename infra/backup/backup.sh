#!/usr/bin/env bash
# Logical backup: custom-format dump, encrypted with age, uploaded to S3-compatible storage
# at a *different provider* than the database. Run nightly (cron/systemd timer/CI schedule).
#
# Env: DATABASE_URL (read-only backup role), AGE_RECIPIENT (public key),
#      BACKUP_BUCKET (s3://…), AWS_* / S3_ENDPOINT_URL for the object store.
set -euo pipefail
ts=$(date -u +%Y%m%dT%H%M%SZ)
file="dorkar-${ts}.dump.age"
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --compress=9 \
  | age -r "$AGE_RECIPIENT" > "/tmp/${file}"
aws s3 cp "/tmp/${file}" "${BACKUP_BUCKET}/daily/${file}" ${S3_ENDPOINT_URL:+--endpoint-url "$S3_ENDPOINT_URL"}
sha256sum "/tmp/${file}" | aws s3 cp - "${BACKUP_BUCKET}/daily/${file}.sha256" ${S3_ENDPOINT_URL:+--endpoint-url "$S3_ENDPOINT_URL"}
rm -f "/tmp/${file}"
echo "backup uploaded: ${file}"
# Retention (7 daily / 4 weekly / 12 monthly) is enforced by bucket lifecycle rules.
