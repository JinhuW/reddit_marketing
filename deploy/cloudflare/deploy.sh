#!/usr/bin/env bash
# Deploy the threadline-edge Worker, then smoke-check the public hostname through Cloudflare.
# Usage: deploy/cloudflare/deploy.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST=reddits.recycleservers.com

node --test "$DIR/worker.test.mjs"
# A local shell may carry a CLOUDFLARE_API_TOKEN scoped for something else; use the `wrangler login` session.
[[ -z "${CI:-}" ]] && unset CLOUDFLARE_API_TOKEN
(cd "$DIR" && npx -y wrangler@4.158.0 deploy)

echo "▸ smoke check https://$HOST"
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/login")
[[ "$code" == 200 ]] || { echo "error: /login answered $code" >&2; exit 1; }
asset=$(curl -s "https://$HOST/login" | grep -o '/_next/static/[^"]*\.css' | head -1)
if [[ -n "$asset" ]]; then
  curl -s -o /dev/null "https://$HOST$asset"
  echo "  $asset → $(curl -sI "https://$HOST$asset" | tr -d '\r' | grep -i '^cache-control:' || true)"
fi
echo "ok"
