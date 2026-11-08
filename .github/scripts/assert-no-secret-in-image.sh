#!/usr/bin/env bash
# Fails if a secret value appears anywhere in a local Docker image: build history (RUN/ARG lines), image config
# (ENV, labels) or any layer's files, including files deleted by a later layer.
# Used by .github/workflows/images.yml before an image is pushed (ADR-0001: the CloakBrowser key is a BuildKit
# secret, never an image layer).
#
#   SECRET_VALUE=... assert-no-secret-in-image.sh <image>
#
# The secret is read from the environment, never from argv, and is never printed.
# No pipefail: `producer | grep -q` stops reading at the first match, the producer then dies of SIGPIPE, and with
# pipefail that match would read as "not found".
set -eu

image="${1:?usage: SECRET_VALUE=... $0 <image>}"
secret="${SECRET_VALUE:-}"
if [ "${#secret}" -lt 8 ]; then
  echo "assert-no-secret-in-image: SECRET_VALUE is empty or shorter than 8 characters; refusing to run a check that proves nothing" >&2
  exit 2
fi

# Without pipefail a missing image would make every grep below "not found"; fail loudly first instead.
docker image inspect "$image" >/dev/null

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
found=0

if docker history --no-trunc --format '{{.CreatedBy}}' "$image" | grep -qF -- "$secret"; then
  echo "::error::secret found in docker history of $image"
  found=1
fi

if docker image inspect "$image" | grep -qF -- "$secret"; then
  echo "::error::secret found in the image config (ENV, labels, cmd) of $image"
  found=1
fi

docker save "$image" -o "$work/image.tar"
mkdir "$work/x"
tar -xf "$work/image.tar" -C "$work/x"
while IFS= read -r -d '' f; do
  if gzip -t "$f" 2>/dev/null; then
    reader=(gzip -dc "$f")
  elif zstd -t "$f" >/dev/null 2>&1; then
    reader=(zstd -dc "$f")
  else
    reader=(cat "$f")
  fi
  if "${reader[@]}" | grep -qaF -- "$secret"; then
    echo "::error::secret found in layer blob ${f#"$work/x/"} of $image"
    found=1
  fi
done < <(find "$work/x" -type f -print0)

if [ "$found" -ne 0 ]; then
  exit 1
fi
echo "ok: secret not present in history, config or any layer of $image"
