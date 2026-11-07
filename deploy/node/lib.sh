#!/usr/bin/env bash
# Shared helpers for install.sh and backup.sh. Pure functions only (no Docker, no network), so
# test/lib.test.sh can exercise them anywhere.
#
# The node env file holds NODE_TOKEN and CLOAKBROWSER_LICENSE_KEY. It is read here line by line, never
# `source`d (it uses Docker env-file syntax, not shell syntax), and no function prints a value it reads.

# Names that namespace everything Threadline creates on a shared host (compose.yml uses the same literals:
# project threadline-node, container tl-node-agent, network tl-browsers; volumes are tl-profile-<id>).
# shellcheck disable=SC2034 # used by the scripts that source this file
TL_NETWORK=tl-browsers
# shellcheck disable=SC2034
TL_AGENT_CONTAINER=tl-node-agent
TL_CONNECTED_LINE='connected to gateway'
# Registry host for images built on the node. `.invalid` never resolves (RFC 2606), so a pull of a local tag
# fails at DNS instead of fetching e.g. docker.io/threadline/* from whoever owns that Docker Hub namespace (the
# agent pulls BROWSER_IMAGE when it is missing, and another tenant's `docker image prune -a` can remove it).
# Only registry images set explicitly (AGENT_IMAGE / BROWSER_IMAGE) are ever pulled.
TL_LOCAL_REGISTRY=tl.invalid

# env_get KEY FILE: print the value of KEY from a Docker-style env file (last assignment wins).
# Accepts `KEY=value`, `export KEY=value`, and one pair of matching surrounding quotes. Comments and blank
# lines are ignored. No expansion. Exit 1 if the key is absent.
env_get() {
  local key="$1" file="$2" line k v found=1 out=''
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in '' | '#'*) continue ;; esac
    line="${line#export }"
    k="${line%%=*}"
    [ "$k" == "$line" ] && continue
    k="${k%"${k##*[![:space:]]}"}"
    [ "$k" == "$key" ] || continue
    v="${line#*=}"
    if [ "${#v}" -ge 2 ]; then
      case "$v" in
        \"*\") v="${v:1:${#v}-2}" ;;
        \'*\') v="${v:1:${#v}-2}" ;;
      esac
    fi
    out="$v"
    found=0
  done <"$file"
  [ "$found" -eq 0 ] && printf '%s' "$out"
  return "$found"
}

# env_value KEY FILE: like env_get, but prints nothing and succeeds when the key is absent.
env_value() {
  env_get "$1" "$2" || true
}

# env_keys FILE: print every key assigned in a Docker-style env file, one per line (values are never printed).
env_keys() {
  local line k
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    k="${line%%=*}"
    [ "$k" == "$line" ] && continue
    [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && printf '%s\n' "$k"
  done <"$1"
  return 0
}

# is_placeholder VALUE: true for empty values and values still holding the template's `change-me` marker.
is_placeholder() {
  case "$1" in '' | *change-me*) return 0 ;; *) return 1 ;; esac
}

# valid_node_name NAME: same rule as @threadline/shared NodeName (packages/shared/src/node-protocol.ts).
valid_node_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]
}

# gateway_url_ok URL: wss:// (or ws:// for local testing) with a host.
gateway_url_ok() {
  [[ "$1" =~ ^wss?://[^/[:space:]]+(/[^[:space:]]*)?$ ]]
}

# file_mode PATH: octal permission bits, GNU or BSD stat.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# file_gid PATH: numeric group of a path (follows symlinks), GNU or BSD stat.
file_gid() {
  stat -L -c '%g' "$1" 2>/dev/null || stat -L -f '%g' "$1"
}

# select_profile_volumes: filter `docker volume ls --format '{{.Name}}'` output down to tl-profile-* names.
# Anything else on a shared host (other projects' volumes) is never selected.
select_profile_volumes() {
  local name
  while IFS= read -r name; do
    [[ "$name" =~ ^tl-profile-[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] && printf '%s\n' "$name"
  done
  return 0
}

# browser_image_tag ENGINE CLOAK_VERSION: local tag (unpullable registry host) for an image built from
# apps/browser-profile.
browser_image_tag() {
  if [ "$1" == chromium ]; then
    printf '%s/browser-profile:chromium' "$TL_LOCAL_REGISTRY"
  else
    printf '%s/browser-profile:%s' "$TL_LOCAL_REGISTRY" "$2"
  fi
}

# valid_cloak_version VERSION: safe as a tag and a file name (the Dockerfile builds a path from it).
valid_cloak_version() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]
}

# agent_log_state: read agent log lines on stdin; print `connected`, `fatal:<reason>` or `waiting`.
# Matches the node agent's own messages (apps/node-agent/src/client.ts, index.ts), which never carry secrets.
agent_log_state() {
  local line state=waiting
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *"$TL_CONNECTED_LINE"*) state=connected ;;
      *'invalid node agent environment'*) state='fatal:invalid environment (see the variable names above)' ;;
      *'(4401)'*) state='fatal:gateway rejected NODE_TOKEN (4401)' ;;
      *'(4409)'*) state='fatal:another agent is connected with this NODE_NAME (4409)' ;;
      *'(4426)'*) state='fatal:protocol version mismatch with the gateway (4426)' ;;
    esac
  done
  printf '%s' "$state"
}
