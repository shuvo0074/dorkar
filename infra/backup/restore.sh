#!/usr/bin/env bash
# Restore a logical backup into a target Postgres (new provider, VPS, laptop or restore drill).
#   ./restore.sh <backup-file.dump.age> <TARGET_ADMIN_URL>
# Env: AGE_IDENTITY (path to private key file).
set -euo pipefail
src=$1; target=$2
here=$(cd "$(dirname "$0")" && pwd)
# Roles/schemas first, so ownership maps onto least-privilege service roles.
PGURL="$target" "$here/../docker/postgres/init.sh"
age -d -i "$AGE_IDENTITY" "$src" > /tmp/restore.dump
trap 'rm -f /tmp/restore.dump' EXIT
# Restore each service schema *as its service role*, so the service owns its objects again.
for schema in $(pg_restore --list /tmp/restore.dump | awk '$4=="SCHEMA" {print $6}' | sort -u); do
  pg_restore --dbname="$target" --no-owner --no-acl --exit-on-error --jobs=4 \
    --role="svc_${schema}" --schema="$schema" /tmp/restore.dump
done
"$here/verify.sh" "$target"
