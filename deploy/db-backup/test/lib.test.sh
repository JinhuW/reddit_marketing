#!/usr/bin/env bash
# Unit tests for lib.sh (no Docker, no network): bash deploy/db-backup/test/lib.test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$here/../lib.sh"

fails=0
pass=0
eq() {
  if [ "$2" == "$3" ]; then
    pass=$((pass + 1))
  else
    fails=$((fails + 1))
    printf 'FAIL %s\n  expected: %q\n  actual:   %q\n' "$1" "$3" "$2"
  fi
}

keys() {
  local d
  for d in "$@"; do printf 'p/daily/threadline-%sT023000Z.dump\n' "$d"; done
}

eq 'dump_name' "$(dump_name 20261108T023000Z)" 'threadline-20261108T023000Z.dump'

# 9 nightly dumps, keep 7: the two oldest go, whatever order the listing arrives in.
nine="$(keys 20261103 20261101 20261109 20261102 20261105 20261104 20261108 20261107 20261106)"
eq 'keep 7 of 9' "$(select_expired 7 <<<"$nine")" "$(keys 20261102 20261101)"
eq 'keep 9 of 9' "$(select_expired 9 <<<"$nine")" ''
eq 'keep 20 of 9' "$(select_expired 20 <<<"$nine")" ''
eq 'keep 0 deletes all' "$(select_expired 0 <<<"$nine" | wc -l | tr -d ' ')" '9'
eq 'empty listing' "$(select_expired 7 </dev/null)" ''

# Same-day reruns sort by time too.
eq 'time breaks ties' \
  "$(printf '%s\n' p/threadline-20261108T023000Z.dump p/threadline-20261108T120000Z.dump | select_expired 1)" \
  'p/threadline-20261108T023000Z.dump'

# Foreign objects and the CLI's "None" are never selected for deletion.
mixed="$(printf '%s\n' None p/daily/README.txt p/daily/threadline-latest.dump p/daily/other-20261101T023000Z.dump \
  "$(keys 20261101 20261102)")"
eq 'foreign keys survive' "$(select_expired 0 <<<"$mixed")" "$(keys 20261102 20261101)"

# Bad keep values are rejected rather than deleting everything.
if select_expired '' <<<"$nine" >/dev/null 2>&1; then eq 'reject empty keep' ok fail; else eq 'reject empty keep' ok ok; fi
if select_expired -1 <<<"$nine" >/dev/null 2>&1; then eq 'reject -1' ok fail; else eq 'reject -1' ok ok; fi
if select_expired 7d <<<"$nine" >/dev/null 2>&1; then eq 'reject 7d' ok fail; else eq 'reject 7d' ok ok; fi

eq 'newest_dump' "$(newest_dump <<<"$mixed")" "$(keys 20261102)"
eq 'newest_dump empty' "$(newest_dump </dev/null)" ''

eq 'is_weekly_day yes' "$(is_weekly_day 7 7 && echo y || echo n)" 'y'
eq 'is_weekly_day no' "$(is_weekly_day 6 7 && echo y || echo n)" 'n'

eq 'join_prefix default' "$(join_prefix threadline/postgres daily)" 'threadline/postgres/daily'
eq 'join_prefix slashes' "$(join_prefix /a/b/ weekly)" 'a/b/weekly'
eq 'join_prefix empty' "$(join_prefix '' daily)" 'daily'

printf '%d passed, %d failed\n' "$pass" "$fails"
[ "$fails" = 0 ]
