#!/usr/bin/env bash
# Nightly off-Railway Postgres dump.
#
#   pg_dump -Fc  ->  pg_restore --list (local sanity check)  ->  s3://$S3_BUCKET/$S3_PREFIX/daily/<name>
#   on BACKUP_WEEKLY_DOW also            ->  s3://$S3_BUCKET/$S3_PREFIX/weekly/<name>
#   then prune: keep the BACKUP_KEEP_DAILY newest daily and BACKUP_KEEP_WEEKLY newest weekly dumps.
#
# Required: DATABASE_URL, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
# Optional: S3_ENDPOINT, S3_REGION, S3_PREFIX (default threadline/postgres), S3_ADDRESSING_STYLE,
#           BACKUP_KEEP_DAILY (7), BACKUP_KEEP_WEEKLY (4), BACKUP_WEEKLY_DOW (7 = Sunday, ISO weekday),
#           BACKUP_TIMESTAMP (YYYYMMDDTHHMMSSZ; defaults to now, UTC), BACKUP_WORKDIR (default $TMPDIR or /tmp).
#
# Exits non-zero on any failure so the Railway cron run shows as failed. Never prints DATABASE_URL or keys.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
# shellcheck source=s3.sh
. "$here/s3.sh"

log() { printf '%s db-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

require_env DATABASE_URL
s3_setup

keep_daily="${BACKUP_KEEP_DAILY:-7}"
keep_weekly="${BACKUP_KEEP_WEEKLY:-4}"
weekly_dow="${BACKUP_WEEKLY_DOW:-7}"
stamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
if ! [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "db-backup: BACKUP_TIMESTAMP must look like 20261108T023000Z" >&2
  exit 2
fi
dow="$(date -u -d "${stamp:0:8}" +%u)"
name="$(dump_name "$stamp")"
daily_prefix="$(join_prefix "$S3_PREFIX" daily)"
weekly_prefix="$(join_prefix "$S3_PREFIX" weekly)"

workdir="$(mktemp -d "${BACKUP_WORKDIR:-${TMPDIR:-/tmp}}/db-backup.XXXXXX")"
cleanup() { rm -rf "$workdir" "${AWS_CONFIG_FILE:-}"; }
trap cleanup EXIT
file="$workdir/$name"

log "dumping database to $name"
started=$SECONDS
pg_dump --format=custom --no-password --dbname="$DATABASE_URL" --file="$file"
size="$(stat -c %s "$file")"
entries="$(pg_restore --list "$file" | grep -cE '^[0-9]+;' || true)"
if [ "$entries" -lt 1 ]; then
  echo "db-backup: pg_restore --list found no entries in $name; not uploading" >&2
  exit 1
fi
log "dump ok: $size bytes, $entries TOC entries, $((SECONDS - started))s"

upload() {
  local key="$1/$name" remote
  s3 s3 cp --only-show-errors "$file" "s3://$S3_BUCKET/$key"
  remote="$(s3 s3api head-object --bucket "$S3_BUCKET" --key "$key" --query ContentLength --output text)"
  if [ "$remote" != "$size" ]; then
    echo "db-backup: uploaded size $remote != local size $size for $key" >&2
    exit 1
  fi
  log "uploaded s3://$S3_BUCKET/$key"
}

prune() {
  local prefix="$1" keep="$2" key keys expired
  keys="$(s3_list_keys "$prefix")"
  expired="$(printf '%s\n' "$keys" | select_expired "$keep")"
  [ -n "$expired" ] || return 0
  while IFS= read -r key; do
    s3 s3 rm --only-show-errors "s3://$S3_BUCKET/$key"
    log "pruned s3://$S3_BUCKET/$key"
  done <<<"$expired"
}

upload "$daily_prefix"
if is_weekly_day "$dow" "$weekly_dow"; then
  upload "$weekly_prefix"
fi

# Prune only after the new dump is safely uploaded, so a failed run never shrinks the set.
prune "$daily_prefix" "$keep_daily"
prune "$weekly_prefix" "$keep_weekly"
log "done"
