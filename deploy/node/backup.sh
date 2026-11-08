#!/usr/bin/env bash
# Weekly restic backup of the browser-profile volumes (tl-profile-*) on a browser node (plan T32).
#
#   /opt/threadline-node/bin/backup.sh [--env-file FILE] [--dry-run]
#
# Reads RESTIC_REPOSITORY, RESTIC_PASSWORD and the backend's credentials (AWS_*, B2_*, AZURE_*, GOOGLE_*,
# RCLONE_*, OS_*) from the node env file. When the repository or password is unset it logs "backup skipped"
# and exits 0, so the timer stays green on a node that has no backup target yet.
#
# restic runs in a throwaway container (`tl-backup`, image RESTIC_IMAGE) with every tl-profile-* volume mounted
# read-only at /backup/<volume>; the host needs no restic install. Running profiles are copied live: Chromium
# recovers such a copy like a profile after a crash. Then `restic forget --keep-weekly RESTIC_KEEP_WEEKLY --prune`.
# Values are passed to the container by name (`-e NAME`), never on the command line, and never printed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

env_file="${TL_NODE_ENV:-/opt/threadline-node/node.env}"
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || { echo 'backup: --env-file needs a path' >&2; exit 1; }
      env_file="$2"
      shift 2
      ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "backup: unknown option: $1" >&2; exit 1 ;;
  esac
done
[ -r "$env_file" ] || { echo "backup: cannot read $env_file" >&2; exit 1; }

repo_url="$(env_value RESTIC_REPOSITORY "$env_file")"
password="$(env_value RESTIC_PASSWORD "$env_file")"
if is_placeholder "$repo_url" || is_placeholder "$password"; then
  log "backup skipped: RESTIC_REPOSITORY and RESTIC_PASSWORD are not both set in $env_file"
  exit 0
fi
unset repo_url password

keep_weekly="$(env_value RESTIC_KEEP_WEEKLY "$env_file")"
keep_weekly="${keep_weekly:-8}"
[[ "$keep_weekly" =~ ^[1-9][0-9]*$ ]] || { echo 'backup: RESTIC_KEEP_WEEKLY must be a positive integer' >&2; exit 1; }
image="$(env_value RESTIC_IMAGE "$env_file")"
image="${image:-restic/restic:0.18.1}"
node_name="$(env_value NODE_NAME "$env_file")"
node_name="${node_name:-browser-node}"

mapfile -t volumes < <(docker volume ls --format '{{.Name}}' | select_profile_volumes | sort)
if [ "${#volumes[@]}" -eq 0 ]; then
  log "no tl-profile-* volumes on this host; nothing to back up"
  exit 0
fi
log "backing up ${#volumes[@]} volume(s) to the restic repository"

# Export only restic's own variables and backend credentials, by name. NODE_TOKEN and the CloakBrowser key are
# never exported to the restic container.
env_args=()
while IFS= read -r key; do
  case "$key" in
    RESTIC_REPOSITORY | RESTIC_PASSWORD | RESTIC_COMPRESSION | AWS_* | B2_* | AZURE_* | GOOGLE_* | RCLONE_* | OS_*)
      export "$key=$(env_value "$key" "$env_file")"
      env_args+=(-e "$key")
      ;;
  esac
done < <(env_keys "$env_file" | sort -u)

mounts=()
# A local repository (a second disk: RESTIC_REPOSITORY=/mnt/backup/restic) is bind-mounted at the same path.
if [[ "$RESTIC_REPOSITORY" == /* ]]; then
  mkdir -p "$RESTIC_REPOSITORY"
  mounts+=(--mount "type=bind,source=$RESTIC_REPOSITORY,target=$RESTIC_REPOSITORY")
fi
for v in "${volumes[@]}"; do
  mounts+=(--mount "type=volume,source=$v,target=/backup/$v,readonly")
done

restic() {
  docker run --rm --name "tl-backup-$$" --hostname "$node_name" "${env_args[@]}" "${mounts[@]}" "$image" "$@"
}

if [ "$dry_run" -eq 1 ]; then
  log "dry run: would run $image with ${#env_args[@]} env flag(s) for: ${volumes[*]}"
  exit 0
fi

# First run against an empty repository: initialise it.
if ! restic cat config >/dev/null 2>&1; then
  log "initialising the restic repository"
  restic init >/dev/null
fi
restic backup --tag threadline --tag tl-profile --host "$node_name" /backup
restic forget --tag tl-profile --host "$node_name" --keep-weekly "$keep_weekly" --prune
log "done"
