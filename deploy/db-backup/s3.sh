#!/usr/bin/env bash
# S3 client setup shared by backup.sh and verify-latest.sh. Sourced, not executed.
# Reads S3_* variables; the AWS CLI reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the environment itself.
# Nothing here prints a credential.

require_env() {
  local name missing=0
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      echo "db-backup: missing required variable $name" >&2
      missing=1
    fi
  done
  [ "$missing" = 0 ]
}

s3_setup() {
  require_env S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY || return 1
  export AWS_DEFAULT_REGION="${S3_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
  # S3-compatible stores (OCI Object Storage, R2, MinIO) reject the CRC checksums AWS CLI v2 adds by default.
  export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
  export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"
  export AWS_PAGER=""
  # A private config file so the container never depends on ~/.aws. Path-style addressing is what OCI's
  # S3 compatibility API expects; it is the default whenever a custom endpoint is set.
  local style="${S3_ADDRESSING_STYLE:-}"
  if [ -z "$style" ]; then
    if [ -n "${S3_ENDPOINT:-}" ]; then style=path; else style=auto; fi
  fi
  AWS_CONFIG_FILE="$(mktemp)"
  export AWS_CONFIG_FILE
  printf '[default]\ns3 =\n    addressing_style = %s\n' "$style" >"$AWS_CONFIG_FILE"
  S3_PREFIX="${S3_PREFIX-threadline/postgres}"
}

# aws CLI with the optional custom endpoint.
s3() {
  if [ -n "${S3_ENDPOINT:-}" ]; then
    aws --endpoint-url "$S3_ENDPOINT" "$@"
  else
    aws "$@"
  fi
}

# s3_list_keys <prefix>: every object key under <prefix>/, one per line (the CLI follows pagination).
s3_list_keys() {
  local out
  out="$(s3 s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$1/" --query 'Contents[].Key' --output text)" ||
    return 1
  printf '%s\n' "$out" | tr '\t' '\n' | { grep -v -e '^None$' -e '^$' || true; }
}
