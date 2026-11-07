#!/usr/bin/env bash
# Download a dump from the bucket and prove it is readable.
#
#   verify-latest.sh             newest dump under $S3_PREFIX/daily/
#   verify-latest.sh weekly      newest dump under $S3_PREFIX/weekly/
#   verify-latest.sh <key>       that exact object key
#
# Always runs `pg_restore --list`. If VERIFY_RESTORE_URL is set (a scratch database that already exists and has
# the pgvector extension available), it also restores into it with --no-owner --no-acl --exit-on-error.
# Required: S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY. Optional: S3_ENDPOINT, S3_REGION, S3_PREFIX.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
# shellcheck source=s3.sh
. "$here/s3.sh"

log() { printf '%s db-backup verify: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

s3_setup
target="${1:-daily}"
case "$target" in
  daily | weekly)
    key="$(s3_list_keys "$(join_prefix "$S3_PREFIX" "$target")" | newest_dump)"
    if [ -z "$key" ]; then
      echo "db-backup verify: no dump found under $(join_prefix "$S3_PREFIX" "$target")/" >&2
      exit 1
    fi
    ;;
  *) key="$target" ;;
esac

workdir="$(mktemp -d "${BACKUP_WORKDIR:-${TMPDIR:-/tmp}}/db-verify.XXXXXX")"
cleanup() { rm -rf "$workdir" "${AWS_CONFIG_FILE:-}"; }
trap cleanup EXIT
file="$workdir/${key##*/}"

s3 s3 cp --only-show-errors "s3://$S3_BUCKET/$key" "$file"
list="$workdir/toc.txt"
pg_restore --list "$file" >"$list"
entries="$(grep -cE '^[0-9]+;' "$list" || true)"
tables="$(grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ' "$list" || true)"
if [ "$entries" -lt 1 ]; then
  echo "db-backup verify: pg_restore --list read no entries from $key" >&2
  exit 1
fi
log "pg_restore --list ok: s3://$S3_BUCKET/$key, $(stat -c %s "$file") bytes, $entries TOC entries, $tables tables with data"

if [ -n "${VERIFY_RESTORE_URL:-}" ]; then
  started=$SECONDS
  pg_restore --no-owner --no-acl --exit-on-error --no-password --dbname="$VERIFY_RESTORE_URL" "$file"
  log "restore into scratch database ok in $((SECONDS - started))s"
fi
