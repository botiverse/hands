#!/usr/bin/env bash
# Exercises the /versions durability guard from deploy-hands-server.yml against
# real Cloudflare response shapes.
#
# Why this exists: the guard shipped in #508 was written as
#   [.result.items[]?.id, .result[]?.id] | index($a)
# which looks like "tolerate both shapes" but is a hard jq error on BOTH — on
# the object shape `.result[]?` iterates the object's values, yields the items
# ARRAY, and `.id` on an array aborts. The step is fail-closed, so every deploy
# after #508 refused to write (run 33887600418), and it was the first deploy to
# reach the new code: the guard never passed once.
#
# Two things this file does deliberately:
#
#   The expression is EXTRACTED from the workflow, not copied. A copy would let
#   the tested text and the shipped text drift apart silently, which is the same
#   class of failure as the bug itself — something that reads like a check while
#   checking nothing.
#
#   It self-tests first, against the historical broken expression. "All cases
#   passed" is worthless if the case table cannot tell the two expressions
#   apart, and a table that cannot fail is indistinguishable in the log from a
#   table that passed. So the known-bad expression must fail the positive cases
#   before the real one is allowed to report anything.
set -euo pipefail

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/workflows/deploy-hands-server.yml"
[[ -r "$workflow" ]] || { echo "CANNOT RUN: cannot read $workflow" >&2; exit 2; }

guards="$(grep -c 'live version ${anchor} is absent from /versions' "$workflow" || true)"
[[ "$guards" == "1" ]] || { echo "CANNOT RUN: expected exactly 1 durability guard, found $guards" >&2; exit 2; }

# The jq program is the single-quoted argument on the `jq -e --arg a` line.
program="$(grep -m1 -- 'jq -e --arg a "${anchor}"' "$workflow" | sed -E "s/^[^']*'//; s/'[^']*$//")"
[[ -n "$program" ]] || { echo "CANNOT RUN: could not extract the jq program from $workflow" >&2; exit 2; }

# The expression as it shipped in #508. Pinned here as the thing the case table
# must be able to reject; it is not what runs in production.
broken='[.result.items[]?.id, .result[]?.id] | index($a)'

paged='{"success":true,"result":{"items":[{"id":"11111111-1111-1111-1111-111111111111"},{"id":"22222222-2222-2222-2222-222222222222"}]}}'
bare='{"success":true,"result":[{"id":"11111111-1111-1111-1111-111111111111"}]}'
empty='{"success":true,"result":{"items":[]}}'

# name | expected | anchor | payload. "present" means the guard lets the deploy
# proceed; "absent" means it fires and the deploy is refused.
cases=(
  "paged shape, anchor present|present|11111111-1111-1111-1111-111111111111|$paged"
  "paged shape, anchor present at end|present|22222222-2222-2222-2222-222222222222|$paged"
  "bare-array shape, anchor present|present|11111111-1111-1111-1111-111111111111|$bare"
  "paged shape, anchor absent|absent|99999999-9999-9999-9999-999999999999|$paged"
  "bare-array shape, anchor absent|absent|99999999-9999-9999-9999-999999999999|$bare"
  "no versions at all|absent|11111111-1111-1111-1111-111111111111|$empty"
)

evaluate() { # program anchor json -> present|absent
  if jq -e --arg a "$2" "$1" >/dev/null 2>&1 <<<"$3"; then echo present; else echo absent; fi
}

# Self-test: the known-bad expression must fail every "present" case. If it does
# not, the table cannot discriminate and a clean result below proves nothing.
selftest_rejected=0
for entry in "${cases[@]}"; do
  IFS='|' read -r name expect anchor json <<<"$entry"
  [[ "$expect" == "present" ]] || continue
  if [[ "$(evaluate "$broken" "$anchor" "$json")" != "$expect" ]]; then
    selftest_rejected=$((selftest_rejected + 1))
  fi
done
if [[ "$selftest_rejected" -ne 3 ]]; then
  echo "CANNOT RUN: the #508 expression failed only ${selftest_rejected} of 3 positive cases." >&2
  echo "The table no longer distinguishes the regression it exists to catch." >&2
  exit 2
fi
echo "self-test ok: the #508 expression fails all 3 positive cases"
echo "guard: $program"

fail=0
for entry in "${cases[@]}"; do
  IFS='|' read -r name expect anchor json <<<"$entry"
  got="$(evaluate "$program" "$anchor" "$json")"
  if [[ "$got" == "$expect" ]]; then
    printf 'ok   %-46s %s\n' "$name" "$got"
  else
    printf 'FAIL %-46s expected=%s got=%s\n' "$name" "$expect" "$got"; fail=1
  fi
done
exit "$fail"
