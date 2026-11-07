#!/usr/bin/env bash
# End-to-end test of the backup image against a local Postgres and an S3 mock (adobe/s3mock). Needs Docker.
#
#   deploy/db-backup/test/e2e.sh
#
# E2E_DATABASE_URL  database to dump, as seen from a container
#                   (default postgresql://threadline:threadline@host.docker.internal:5432/threadline)
#
# Restores go into a throwaway pgvector/pgvector:pg18 container, the same major version as Railway Postgres
# (a pg_dump 18 archive uses settings, e.g. transaction_timeout, that older servers reject).
#
# It runs ten nightly backups (2026-11-01 .. 2026-11-10), then checks daily/weekly retention, that
# verify-latest.sh reads the newest dump with pg_restore --list, that a full restore matches the source row
# counts, that a failing run uploads nothing, and that no credential reaches the logs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="threadline/db-backup:e2e"
id="tl-dbbackup-e2e-$$"
net="$id"
s3c="$id-s3"
bucket="threadline-backups"
secret="tl-e2e-secret-marker-$$"
db_url="${E2E_DATABASE_URL:-postgresql://threadline:threadline@host.docker.internal:5432/threadline}"
pgc="$id-pg"
restore_url="postgresql://postgres:restore@$pgc:5432/restore"
logs="$(mktemp)"

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() {
  printf 'FAIL %s\n' "$1"
  fails=$((fails + 1))
}
check() { if [ "$2" == "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

cleanup() {
  docker rm -f "$s3c" "$pgc" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -f "$logs"
}
trap cleanup EXIT

docker build -q -t "$image" "$here/.." >/dev/null
docker network create "$net" >/dev/null
docker run -d --name "$s3c" --network "$net" adobe/s3mock:3.12.0 >/dev/null
docker run -d --name "$pgc" --network "$net" -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=restore \
  pgvector/pgvector:pg18 >/dev/null

# run <extra docker args...> -- <command...>: the backup image with S3 settings pointing at the mock.
run() {
  local args=()
  while [ "$1" != "--" ]; do
    args+=("$1")
    shift
  done
  shift
  docker run --rm --network "$net" --add-host=host.docker.internal:host-gateway \
    -e S3_ENDPOINT="http://$s3c:9090" -e S3_BUCKET="$bucket" -e S3_REGION=us-east-1 \
    -e AWS_ACCESS_KEY_ID=e2e -e AWS_SECRET_ACCESS_KEY="$secret" ${args[@]+"${args[@]}"} "$image" "$@"
}
aws_() { run --entrypoint aws -- --endpoint-url "http://$s3c:9090" "$@"; }
keys() { aws_ s3api list-objects-v2 --bucket "$bucket" --prefix "$1" --query 'Contents[].Key' --output text |
  tr '\t' '\n' | grep -v -e '^None$' -e '^$' | sed 's#.*/##' | sort | tr '\n' ' ' | sed 's/ $//'; }

for _ in $(seq 1 30); do
  aws_ s3 mb "s3://$bucket" >/dev/null 2>&1 && break
  sleep 1
done

# Unit tests again under the image's bash (Debian), next to the code that ships.
run --entrypoint bash -v "$here/..:/src:ro" -- /src/test/lib.test.sh >/dev/null && ok 'lib.test.sh in image' ||
  bad 'lib.test.sh in image'

# Ten nights. 2026-11-01 and 2026-11-08 are Sundays (ISO weekday 7). Keep 7 daily and, to exercise weekly
# pruning in ten runs, 1 weekly.
for d in 01 02 03 04 05 06 07 08 09 10; do
  if run -e DATABASE_URL="$db_url" -e BACKUP_TIMESTAMP="202611${d}T023000Z" -e BACKUP_KEEP_WEEKLY=1 \
    -- /opt/db-backup/backup.sh >>"$logs" 2>&1; then :; else
    bad "backup run 202611$d"
    tail -20 "$logs"
    exit 1
  fi
done
ok 'ten backup runs'

check 'daily keeps the 7 newest' "$(keys threadline/postgres/daily/)" \
  "$(for d in 04 05 06 07 08 09 10; do printf 'threadline-202611%sT023000Z.dump ' "$d"; done | sed 's/ $//')"
check 'weekly keeps the newest Sunday' "$(keys threadline/postgres/weekly/)" 'threadline-20261108T023000Z.dump'

# A failing run (bad database) exits non-zero and uploads nothing.
before="$(keys threadline/postgres/)"
if run -e DATABASE_URL="postgresql://threadline:wrong-$secret@host.docker.internal:5432/nope" \
  -e BACKUP_TIMESTAMP=20261111T023000Z -- /opt/db-backup/backup.sh >>"$logs" 2>&1; then
  bad 'failing run exits non-zero'
else
  ok 'failing run exits non-zero'
fi
check 'failing run uploads and prunes nothing' "$(keys threadline/postgres/)" "$before"

# Missing configuration fails fast.
if run -e DATABASE_URL="$db_url" -e S3_BUCKET= -- /opt/db-backup/backup.sh >>"$logs" 2>&1; then
  bad 'missing S3_BUCKET fails'
else
  ok 'missing S3_BUCKET fails'
fi

# Done when: the newest dump in the bucket reads with pg_restore --list, and restores.
for _ in $(seq 1 30); do
  run --entrypoint pg_isready -- -q -d "$restore_url" && break
  sleep 1
done
out="$(run -e VERIFY_RESTORE_URL="$restore_url" -- /opt/db-backup/verify-latest.sh 2>&1)" || {
  bad "verify-latest.sh: $out"
  exit 1
}
printf '%s\n' "$out" >>"$logs"
printf '%s\n' "$out" | grep -q 'pg_restore --list ok: s3://threadline-backups/threadline/postgres/daily/threadline-20261110T023000Z.dump' &&
  ok 'verify-latest reads the newest daily dump' || bad "verify-latest output: $out"
run -- /opt/db-backup/verify-latest.sh weekly >>"$logs" 2>&1 && ok 'verify-latest weekly' || bad 'verify-latest weekly'

counts() {
  run --entrypoint psql -- "$1" -Atc "SELECT concat_ws('/', (SELECT count(*) FROM \"Workspace\"),
    (SELECT count(*) FROM \"Draft\"), (SELECT count(*) FROM \"Lead\"), (SELECT count(*) FROM \"AuditEvent\"))"
}
src="$(counts "$db_url")"
dst="$(counts "$restore_url")"
check "restored row counts match source (Workspace/Draft/Lead/AuditEvent = $src)" "$dst" "$src"

# Secrets never reach the logs.
if grep -q -e "$secret" -e 'threadline:threadline@' "$logs"; then
  bad 'no credentials in logs'
else
  ok 'no credentials in logs'
fi

[ "$fails" = 0 ] && echo 'e2e passed' || {
  echo "e2e: $fails failure(s)"
  exit 1
}
