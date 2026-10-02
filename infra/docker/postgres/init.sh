#!/usr/bin/env bash
# Creates one schema + one least-privilege login role per service. Idempotent.
# Run as a superuser/admin role: on first container start (docker-entrypoint-initdb.d) or
# manually against any Postgres (managed, VPS, laptop):
#   PGURL=postgres://admin@host/dorkar SVC_PASSWORD_IDENTITY=… ./init.sh
# Outside development, set every SVC_PASSWORD_<SERVICE>; the dev_* fallbacks are for laptops only.
set -euo pipefail
if [[ -n "${PGURL:-}" ]]; then
  PSQL=(psql -v ON_ERROR_STOP=1 "$PGURL")
else
  PSQL=(psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-dorkar}")
fi

SERVICES=(identity profile verification catalog demand matching offer txn reputation moderation notification media bidding rental lending dispute messaging dashboard)

"${PSQL[@]}" <<SQL
create extension if not exists pg_trgm;
create extension if not exists btree_gist;
revoke create on schema public from public;
SQL

for svc in "${SERVICES[@]}"; do
  var="SVC_PASSWORD_$(echo "$svc" | tr '[:lower:]' '[:upper:]')"
  pw="${!var:-dev_${svc}_pw}"
  "${PSQL[@]}" -v svc="$svc" -v role="svc_${svc}" -v pw="$pw" <<'SQL'
select format('create role %I login password %L', :'role', :'pw')
  where not exists (select 1 from pg_roles where rolname = :'role') \gexec
select format('alter role %I password %L', :'role', :'pw') \gexec
select format('create schema if not exists %I authorization %I', :'svc', :'role') \gexec
select format('revoke all on schema %I from public', :'svc') \gexec
select format('alter role %I set search_path = %I, public', :'role', :'svc') \gexec
select format('alter role %I set statement_timeout = %L', :'role', '15s') \gexec
SQL
done
echo "dorkar: schemas and roles ready"
