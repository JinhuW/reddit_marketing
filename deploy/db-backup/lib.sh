#!/usr/bin/env bash
# Pure helpers shared by backup.sh, verify-latest.sh and the tests. No network, no side effects.

# Dump file names: threadline-YYYYMMDDTHHMMSSZ.dump. They sort chronologically as plain strings.
DUMP_NAME_RE='^threadline-[0-9]{8}T[0-9]{6}Z\.dump$'

# dump_name <stamp>  e.g. dump_name 20261108T023000Z -> threadline-20261108T023000Z.dump
dump_name() {
  printf 'threadline-%s.dump\n' "$1"
}

# is_weekly_day <iso-weekday 1-7> <weekly-dow 1-7>: true when this run also feeds the weekly set.
is_weekly_day() {
  [ "$1" = "$2" ]
}

# select_expired <keep>: reads object keys (one per line, any prefix) on stdin and prints the keys to delete,
# i.e. every dump older than the <keep> newest. Keys whose file name is not a dump name are never printed, so
# anything else someone puts under the prefix survives pruning.
select_expired() {
  local keep="$1"
  case "$keep" in
    '' | *[!0-9]*)
      echo "select_expired: keep must be a non-negative integer, got '$keep'" >&2
      return 2
      ;;
  esac
  local key base
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    base="${key##*/}"
    if [[ "$base" =~ $DUMP_NAME_RE ]]; then
      printf '%s\t%s\n' "$base" "$key"
    fi
  done | LC_ALL=C sort -r -t "$(printf '\t')" -k1,1 | tail -n +"$((keep + 1))" | cut -f2-
}

# newest_dump: reads object keys on stdin and prints the newest dump key (empty if none).
newest_dump() {
  local key base
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    base="${key##*/}"
    if [[ "$base" =~ $DUMP_NAME_RE ]]; then
      printf '%s\t%s\n' "$base" "$key"
    fi
  done | LC_ALL=C sort -r -t "$(printf '\t')" -k1,1 | sed -n '1p' | cut -f2-
}

# join_prefix <prefix> <sub>: "a/b/" + "daily" -> "a/b/daily"; "" + "daily" -> "daily".
join_prefix() {
  local p="${1%/}"
  p="${p#/}"
  if [ -n "$p" ]; then printf '%s/%s\n' "$p" "$2"; else printf '%s\n' "$2"; fi
}
