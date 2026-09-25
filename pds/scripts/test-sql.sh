#!/usr/bin/env bash
# Runs the SQL tests in test/sql/*.test.sql against a local Postgres.
#
# For each test file: create a fresh database, load test/sql/supabase-stub.sql
# (roles, the auth schema, Supabase's default grants), apply every migration
# in supabase/migrations in order, then run the test file. A test file is a
# psql script; any error fails it. Nothing here touches the real project.
#
# Usage (from pds/):
#   PDS_TEST_PG=postgresql://postgres@localhost:5432/postgres ./scripts/test-sql.sh
#   ./scripts/test-sql.sh 017          # only test files whose name contains 017
#
# PDS_TEST_PG must point at a server where that user can CREATE DATABASE.
# Without it, the script starts a throwaway cluster with initdb (Postgres 14+
# binaries on PATH or under /usr/lib/postgresql), which Postgres refuses to
# do as root. Zero npm dependencies, same as npm test.

set -euo pipefail
cd "$(dirname "$0")/.."

FILTER="${1:-}"
TMP=""

cleanup() {
  if [[ -n "$TMP" ]]; then
    "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

if [[ -z "${PDS_TEST_PG:-}" ]]; then
  if [[ "$(id -u)" == "0" ]]; then
    echo "initdb refuses to run as root. Set PDS_TEST_PG to an existing server instead." >&2
    exit 1
  fi
  PGBIN="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb 2>/dev/null | sort -V | tail -1)")"
  if [[ ! -x "$PGBIN/initdb" ]]; then
    echo "No Postgres binaries found. Install Postgres or set PDS_TEST_PG." >&2
    exit 1
  fi
  TMP="$(mktemp -d)"
  "$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
  "$PGBIN/pg_ctl" -D "$TMP/data" -o "-p 54399 -k $TMP -c listen_addresses=''" -l "$TMP/log" start >/dev/null
  PDS_TEST_PG="postgresql://postgres@/postgres?host=$TMP&port=54399"
fi

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
failed=0

for test in test/sql/*.test.sql; do
  name="$(basename "$test" .test.sql)"
  [[ -n "$FILTER" && "$name" != *"$FILTER"* ]] && continue

  db="pds_sqltest_$(echo "$name" | tr -c 'a-zA-Z0-9\n' '_')"
  dburl="${PDS_TEST_PG%/*}/$db"
  [[ "$PDS_TEST_PG" == *\?* ]] && dburl="${PDS_TEST_PG%%/postgres\?*}/$db?${PDS_TEST_PG#*\?}"

  "${PSQL[@]}" "$PDS_TEST_PG" -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" >/dev/null

  if ! out="$(
    "${PSQL[@]}" "$dburl" -f test/sql/supabase-stub.sql 2>&1 &&
    for m in supabase/migrations/*.sql; do "${PSQL[@]}" "$dburl" -f "$m" 2>&1 | grep -v 'NOTICE' || true; done &&
    "${PSQL[@]}" "$dburl" -f "$test" 2>&1
  )" || grep -q 'ERROR' <<<"$out"; then
    echo "not ok - $name"
    echo "$out" | sed 's/^/    /'
    failed=1
  else
    echo "$out" | grep '^ok' | sed "s/^/[$name] /"
  fi

  "${PSQL[@]}" "$PDS_TEST_PG" -c "DROP DATABASE IF EXISTS $db" >/dev/null
done

exit "$failed"
