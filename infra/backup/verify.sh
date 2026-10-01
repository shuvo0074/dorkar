#!/usr/bin/env bash
# Sanity checks after a restore (also used by the weekly restore drill).
#   ./verify.sh <TARGET_URL> [SOURCE_URL]   — with SOURCE_URL, row counts are compared.
set -euo pipefail
target=$1; source=${2:-}
q="select table_schema||'.'||table_name from information_schema.tables
   where table_schema not in ('pg_catalog','information_schema','public') and table_type='BASE TABLE' order by 1"
fail=0
tables=$(psql "$target" -Atc "$q")
[[ -n "$tables" ]] || { echo "FAIL: no application tables found in target"; exit 1; }
for t in $tables; do
  n=$(psql "$target" -Atc "select count(*) from $t")
  if [[ -n "$source" ]]; then
    m=$(psql "$source" -Atc "select count(*) from $t")
    [[ "$n" == "$m" ]] || { echo "MISMATCH $t target=$n source=$m"; fail=1; }
  fi
  printf '%-40s %s\n' "$t" "$n"
done
echo "--- latest migration per schema"
for s in $(psql "$target" -Atc "select table_schema from information_schema.tables where table_name='schema_migrations'"); do
  latest=$(psql "$target" -Atc "select max(name) from $s.schema_migrations")
  echo "$s: ${latest:-NONE}"
  [[ -n "$latest" ]] || fail=1
  if [[ -n "$source" ]]; then
    want=$(psql "$source" -Atc "select max(name) from $s.schema_migrations")
    [[ "$latest" == "$want" ]] || { echo "MISMATCH $s migrations target=$latest source=$want"; fail=1; }
  fi
done
exit $fail
