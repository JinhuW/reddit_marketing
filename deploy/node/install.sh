#!/usr/bin/env bash
# Install or update a Threadline browser node from a repo checkout (plan T32, ADR-0001). Idempotent: run it
# again after `git pull` to redeploy.
#
#   sudo deploy/node/install.sh [options]
#
# Steps: preflight (x86_64, Docker, compose) -> /opt/threadline-node (node.env from the template, mode 600) ->
# network tl-browsers -> node-agent image -> browser-profile image -> seccomp profile -> user-namespace check ->
# compose.env -> `docker compose up -d` -> wait for the agent's "connected to gateway" log line -> weekly backup
# timer.
#
# Options (each also readable from node.env where noted):
#   --prefix DIR            install dir (default /opt/threadline-node)
#   --owner USER            chown the install dir to USER (e.g. the GitHub runner user) so it can redeploy
#   --agent-image REF       run this registry image instead of building (node.env AGENT_IMAGE)
#   --browser-image REF     run this registry image instead of building (node.env BROWSER_IMAGE)
#   --cloak-version V       CloakBrowser build to bake into the browser image (node.env CLOAK_VERSION)
#   --cloak-archive PATH    local archive for that build (node.env CLOAK_ARCHIVE)
#   --cloak-url URL         download URL with {version} (node.env CLOAK_URL); --cloak-sha256 (CLOAK_SHA256)
#   --engine chromium       build the stock-Chromium browser image instead (smoke tests only: no fingerprinting)
#   --rebuild-browser       rebuild the browser image even if the tag already exists
#   --wait SECONDS          how long to wait for the gateway connection (default 180; 0 skips the wait)
#   --skip-timer            do not install the weekly backup timer (also skipped when not root)
#
# Touches only: the install dir, the network tl-browsers, images tl.invalid/* (local builds, never pullable),
# the container tl-node-agent (project threadline-node), throwaway checks named tl-*-check, and systemd units threadline-node-*.
# Never prints NODE_TOKEN, CLOAKBROWSER_LICENSE_KEY or any other value from node.env.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

log() { printf '%s install: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  printf 'install: error: %s\n' "$*" >&2
  exit 1
}

prefix=/opt/threadline-node
owner=''
opt_agent_image=''
opt_browser_image=''
opt_cloak_version=''
opt_cloak_archive=''
opt_cloak_url=''
opt_cloak_sha=''
engine=cloak
rebuild_browser=0
wait_secs=180
skip_timer=0

need_arg() { if [ "$#" -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) need_arg "$@"; prefix="$2"; shift 2 ;;
    --owner) need_arg "$@"; owner="$2"; shift 2 ;;
    --agent-image) need_arg "$@"; opt_agent_image="$2"; shift 2 ;;
    --browser-image) need_arg "$@"; opt_browser_image="$2"; shift 2 ;;
    --cloak-version) need_arg "$@"; opt_cloak_version="$2"; shift 2 ;;
    --cloak-archive) need_arg "$@"; opt_cloak_archive="$2"; shift 2 ;;
    --cloak-url) need_arg "$@"; opt_cloak_url="$2"; shift 2 ;;
    --cloak-sha256) need_arg "$@"; opt_cloak_sha="$2"; shift 2 ;;
    --engine) need_arg "$@"; engine="$2"; shift 2 ;;
    --rebuild-browser) rebuild_browser=1; shift ;;
    --wait) need_arg "$@"; wait_secs="$2"; shift 2 ;;
    --skip-timer) skip_timer=1; shift ;;
    -h | --help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
case "$engine" in cloak | chromium) ;; *) die "--engine must be cloak or chromium" ;; esac
[[ "$wait_secs" =~ ^[0-9]+$ ]] || die "--wait must be a number of seconds"

env_file="$prefix/node.env"
compose_file="$prefix/compose.yml"
compose_env="$prefix/compose.env"
seccomp_file="$prefix/seccomp-browser.json"

# ── 1. preflight ───────────────────────────────────────────────────────────────────────────────────────────────
arch="$(uname -m)"
[ "$arch" == x86_64 ] || die "browser nodes are x86_64 only (CloakBrowser ships no $arch build); this host is $arch"
command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon (is it running, and is $(id -un) root or in the docker group?)"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (apt install docker-compose-plugin)"
# The compose file mounts /var/run/docker.sock; TL_DOCKER_SOCK exists only so the tests can point at a fake.
sock="${TL_DOCKER_SOCK:-/var/run/docker.sock}"
[ -S "$sock" ] || die "$sock is not a socket; the agent needs the host Docker socket"
docker_gid="$(file_gid "$sock")"
log "host ok: $arch, Docker $(docker version --format '{{.Server.Version}}'), socket gid $docker_gid"

# ── 2. install dir and env file ────────────────────────────────────────────────────────────────────────────────
mkdir -p "$prefix" || die "cannot create $prefix (run with sudo the first time, then use --owner)"
chmod 750 "$prefix"
if [ ! -e "$env_file" ]; then
  (umask 077 && cp "$here/node.env.example" "$env_file")
  chmod 600 "$env_file"
  if [ -n "$owner" ]; then chown "$owner" "$prefix" "$env_file"; fi
  log "created $env_file from the template (mode 600)"
  log "fill in GATEWAY_URL, NODE_NAME, NODE_TOKEN and CLOAKBROWSER_LICENSE_KEY there, then run install.sh again"
  exit 2
fi
[ -r "$env_file" ] || die "$env_file is not readable by $(id -un)"
mode="$(file_mode "$env_file")"
if [ "$mode" != 600 ] && [ "$mode" != 400 ]; then
  chmod 600 "$env_file" || die "$env_file has mode $mode and cannot be fixed; it must be 600"
  log "tightened $env_file from mode $mode to 600"
fi
if [ -n "$owner" ]; then
  id "$owner" >/dev/null 2>&1 || die "--owner $owner: no such user"
  chown "$owner" "$prefix" "$env_file"
fi

# Required values: present and not the template's placeholders. Values are checked, never printed.
for key in GATEWAY_URL NODE_NAME NODE_TOKEN; do
  is_placeholder "$(env_value "$key" "$env_file")" && die "$key is not set in $env_file"
done
gateway_url_ok "$(env_value GATEWAY_URL "$env_file")" || die "GATEWAY_URL in $env_file must be wss://<host>[/agent]"
node_name="$(env_value NODE_NAME "$env_file")"
valid_node_name "$node_name" || die "NODE_NAME in $env_file must be lowercase letters, digits and dashes"
token="$(env_value NODE_TOKEN "$env_file")"
[ "${#token}" -ge 16 ] || die "NODE_TOKEN in $env_file must be at least 16 characters"
unset token
# The agent's zod schema rejects these when present but empty (env_file passes "" through).
for key in CLOAKBROWSER_LICENSE_KEY NODE_SEAT_LIMIT NODE_MAX_PROFILES LOG_LEVEL AGENT_VERSION; do
  if env_get "$key" "$env_file" >/dev/null && [ -z "$(env_value "$key" "$env_file")" ]; then
    die "$key is empty in $env_file: set it or comment the line out"
  fi
done
license="$(env_value CLOAKBROWSER_LICENSE_KEY "$env_file")"
if [ "$license" == change-me ]; then
  die "CLOAKBROWSER_LICENSE_KEY is still the template placeholder in $env_file: set it or comment it out"
elif [ -z "$license" ] && [ "$engine" == cloak ]; then
  log "warning: CLOAKBROWSER_LICENSE_KEY is not set; the agent connects but CloakBrowser profiles will not start"
fi

pick() { # pick FLAG_VALUE ENV_KEY: the flag wins, then node.env
  if [ -n "$1" ]; then printf '%s' "$1"; else env_value "$2" "$env_file"; fi
}

# ── 3. network ─────────────────────────────────────────────────────────────────────────────────────────────────
if docker network inspect "$TL_NETWORK" >/dev/null 2>&1; then
  log "network $TL_NETWORK exists"
else
  # A plain bridge, like the agent's own ensureNetwork: browsers reach the internet through their proxies.
  docker network create --driver bridge --label dev.threadline.role=browser-network \
    --label "dev.threadline.node=$node_name" "$TL_NETWORK" >/dev/null
  log "created network $TL_NETWORK"
fi

# ── 4. images ──────────────────────────────────────────────────────────────────────────────────────────────────
ensure_registry_image() {
  if docker image inspect "$1" >/dev/null 2>&1; then
    log "using local copy of $1"
  else
    log "pulling $1"
    docker pull --quiet "$1" >/dev/null
  fi
}

rev="$(git -c safe.directory="$repo" -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || echo local)"
agent_image="$(pick "$opt_agent_image" AGENT_IMAGE)"
if [ -n "$agent_image" ]; then
  ensure_registry_image "$agent_image"
else
  agent_image="$TL_LOCAL_REGISTRY/node-agent:$rev"
  log "building $agent_image from apps/node-agent/Dockerfile"
  TL_REPO_DIR="$repo" TL_AGENT_IMAGE="$agent_image" TL_BROWSER_IMAGE=unused TL_DOCKER_GID="$docker_gid" \
    TL_NODE_ENV="$env_file" docker compose -f "$here/compose.yml" build --quiet agent
  docker tag "$agent_image" "$TL_LOCAL_REGISTRY/node-agent:local"
fi

browser_image="$(pick "$opt_browser_image" BROWSER_IMAGE)"
if [ -n "$browser_image" ] && [ "$engine" == cloak ]; then
  ensure_registry_image "$browser_image"
else
  cloak_version="$(pick "$opt_cloak_version" CLOAK_VERSION)"
  if [ "$engine" == cloak ]; then
    [ -n "$cloak_version" ] || die "set CLOAK_VERSION (or --cloak-version) to build the browser image, or BROWSER_IMAGE to use a registry image"
    valid_cloak_version "$cloak_version" || die "CLOAK_VERSION may only contain letters, digits, dot, dash and underscore"
  fi
  browser_image="$(browser_image_tag "$engine" "$cloak_version")"
  if docker image inspect "$browser_image" >/dev/null 2>&1 && [ "$rebuild_browser" -eq 0 ]; then
    log "browser image $browser_image exists (pass --rebuild-browser to rebuild)"
  else
    build_args=(--platform linux/amd64 --build-arg "ENGINE=$engine" -t "$browser_image")
    if [ "$engine" == cloak ]; then
      archive="$(pick "$opt_cloak_archive" CLOAK_ARCHIVE)"
      vendored="$repo/apps/browser-profile/vendor/cloakbrowser-$cloak_version-linux-x64.tar.gz"
      if [ -n "$archive" ]; then
        [ -f "$archive" ] || die "CloakBrowser archive not found: $archive"
        cmp -s "$archive" "$vendored" 2>/dev/null || cp "$archive" "$vendored"
      fi
      url="$(pick "$opt_cloak_url" CLOAK_URL)"
      [ -f "$vendored" ] || [ -n "$url" ] || die "no CloakBrowser archive: set CLOAK_ARCHIVE (or --cloak-archive) or CLOAK_URL"
      build_args+=(--build-arg "CLOAK_VERSION=$cloak_version")
      if [ -n "$url" ]; then build_args+=(--build-arg "CLOAK_URL=$url"); fi
      sha="$(pick "$opt_cloak_sha" CLOAK_SHA256)"
      if [ -n "$sha" ]; then build_args+=(--build-arg "CLOAK_SHA256=$sha"); fi
      bin="$(env_value CLOAK_BINARY_NAME "$env_file")"
      if [ -n "$bin" ]; then build_args+=(--build-arg "CLOAK_BINARY_NAME=$bin"); fi
      # The key travels as a BuildKit secret read from this one command's environment: not argv, not a layer.
      if [ -n "$license" ]; then build_args+=(--secret "id=cloak_key,env=CLOAKBROWSER_LICENSE_KEY"); fi
    else
      log "warning: --engine chromium builds stock Chromium: no fingerprinting, for smoke tests only"
    fi
    log "building $browser_image from apps/browser-profile"
    CLOAKBROWSER_LICENSE_KEY="$license" docker build --quiet "${build_args[@]}" "$repo/apps/browser-profile" >/dev/null
    if [ "${#license}" -ge 8 ] && [ -x "$repo/.github/scripts/assert-no-secret-in-image.sh" ]; then
      SECRET_VALUE="$license" "$repo/.github/scripts/assert-no-secret-in-image.sh" "$browser_image" >/dev/null ||
        die "the CloakBrowser key was found inside $browser_image; do not use this image"
      log "checked: the license key is not in $browser_image"
    fi
  fi
fi

# ── 5. seccomp profile and user-namespace check ────────────────────────────────────────────────────────────────
# Chromium's sandbox needs unprivileged user namespaces, which Docker's default seccomp profile blocks
# (apps/browser-profile/README.md "Sandbox"). The agent passes this profile to every tl-profile-* container.
install -m 644 "$here/seccomp-browser.json" "$seccomp_file"
install -m 644 "$here/compose.yml" "$compose_file"
if docker run --rm --name tl-userns-check --network none --security-opt "seccomp=$seccomp_file" \
  --entrypoint unshare "$browser_image" --user --map-root-user true >/dev/null 2>&1; then
  log "checked: browser containers can create user namespaces (Chromium sandbox on)"
else
  log "warning: a browser container could not create a user namespace, so Chromium's sandbox will refuse to start"
  log "warning: on Ubuntu 24.04 check: sysctl kernel.apparmor_restrict_unprivileged_userns (see deploy/node/README.md)"
fi

# ── 6. compose.env (no secrets) and start ──────────────────────────────────────────────────────────────────────
tmp="$(mktemp "$prefix/.compose.env.XXXXXX")"
{
  echo "# Generated by deploy/node/install.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ). No secrets; safe to read."
  echo "TL_REPO_DIR=$repo"
  echo "TL_NODE_ENV=$env_file"
  echo "TL_SECCOMP_FILE=$seccomp_file"
  echo "TL_DOCKER_GID=$docker_gid"
  echo "TL_AGENT_IMAGE=$agent_image"
  echo "TL_BROWSER_IMAGE=$browser_image"
} >"$tmp"
chmod 644 "$tmp"
mv "$tmp" "$compose_env"

compose() { docker compose -f "$compose_file" --env-file "$compose_env" "$@"; }
compose config --quiet
log "starting $TL_AGENT_CONTAINER (agent $agent_image, browsers $browser_image)"
compose up -d --no-build --remove-orphans agent >/dev/null

# ── 7. wait for the gateway ────────────────────────────────────────────────────────────────────────────────────
if [ "$wait_secs" -gt 0 ]; then
  log "waiting up to ${wait_secs}s for \"$TL_CONNECTED_LINE\""
  deadline=$((SECONDS + wait_secs))
  state=waiting
  while [ "$SECONDS" -lt "$deadline" ]; do
    started="$(docker inspect --format '{{.State.StartedAt}}' "$TL_AGENT_CONTAINER")"
    state="$(docker logs --since "$started" "$TL_AGENT_CONTAINER" 2>&1 | agent_log_state)"
    [ "$state" == waiting ] || break
    sleep 3
  done
  case "$state" in
    connected) log "$TL_AGENT_CONTAINER is connected; the gateway marks $node_name online" ;;
    *)
      # Agent log lines are redacted by the agent itself (apps/node-agent/src/log.ts).
      docker logs --tail 30 "$TL_AGENT_CONTAINER" >&2 || true
      [ "$state" == waiting ] && die "no gateway connection after ${wait_secs}s (check GATEWAY_URL and outbound HTTPS)"
      die "${state#fatal:}"
      ;;
  esac
fi

# ── 8. weekly backup timer ─────────────────────────────────────────────────────────────────────────────────────
mkdir -p "$prefix/bin"
install -m 755 "$here/backup.sh" "$prefix/bin/backup.sh"
install -m 644 "$here/lib.sh" "$prefix/bin/lib.sh"
if [ "$skip_timer" -eq 1 ]; then
  log "backup timer: skipped (--skip-timer)"
elif [ "$(id -u)" -ne 0 ] || ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then
  log "backup timer: not installed (needs root and systemd); cron alternative in deploy/node/README.md"
else
  sed "s#@PREFIX@#$prefix#g" "$here/systemd/threadline-node-backup.service" \
    >/etc/systemd/system/threadline-node-backup.service
  install -m 644 "$here/systemd/threadline-node-backup.timer" /etc/systemd/system/threadline-node-backup.timer
  systemctl daemon-reload
  systemctl enable --now threadline-node-backup.timer >/dev/null 2>&1
  log "backup timer: threadline-node-backup.timer enabled (weekly)"
fi
# Whoever redeploys later (e.g. the GitHub runner user) must own the install dir; node.env stays mode 600.
if [ -n "$owner" ]; then
  chown -R "$owner" "$prefix"
  # bin/ holds scripts the root backup timer runs; keep them root-owned.
  if [ "$(id -u)" -eq 0 ]; then chown -R root:root "$prefix/bin"; fi
fi

log "done. Status: docker compose -f $compose_file --env-file $compose_env ps"
