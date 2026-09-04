#!/usr/bin/env bash
# Exercises the /versions durability guard from deploy-hands-server.yml against
# real Cloudflare response shapes.
#
# Why this exists: the guard shipped in #508 was written as
#   [.result.items[]?.id, .result[]?.id] | index($a)
# which looks like "tolerate both shapes" but is a hard jq error on BOTH — on
# the object shape `.result[]?` iterates the object's values, yields the items
# ARRAY, and `.id` on an array aborts. The step is fail-closed, so every deploy
# after #508 refused to write (run 33887600418). A guard that can never pass is
# indistinguishable from a guard that is merely strict, so the expression is
# extracted from the workflow itself here — not copied — and a copy would let
# the two drift apart silently.
set -euo pipefail

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/workflows/deploy-hands-server.yml"
[[ -r "$workflow" ]] || { echo "cannot read $workflow" >&2; exit 2; }

matches="$(grep -c 'live version ${anchor} is absent from /versions' "$workflow" || true)"
[[ "$matches" == "1" ]] || { echo "expected exactly 1 durability guard, found $matches" >&2; exit 2; }

# The jq program is the single-quoted argument on the `jq -e --arg a` line.
program="$(grep -m1 -- 'jq -e --arg a "${anchor}"' "$workflow" | sed -E "s/^[^']*'//; s/'[^']*$//")"
[[ -n "$program" ]] || { echo "could not extract the jq program from $workflow" >&2; exit 2; }
echo "guard: $program"

fail=0
check() { # name expect anchor json
  local name="$1" expect="$2" anchor="$3" json="$4" got
  if jq -e --arg a "$anchor" "$program" >/dev/null 2>&1 <<<"$json"; then got=present; else got=absent; fi
  if [[ "$got" == "$expect" ]]; then
    printf 'ok   %-46s %s\n' "$name" "$got"
  else
    printf 'FAIL %-46s expected=%s got=%s\n' "$name" "$expect" "$got"; fail=1
  fi
}

paged='{"success":true,"result":{"items":[{"id":"11111111-1111-1111-1111-111111111111"},{"id":"22222222-2222-2222-2222-222222222222"}]}}'
bare='{"success":true,"result":[{"id":"11111111-1111-1111-1111-111111111111"}]}'
empty='{"success":true,"result":{"items":[]}}'

# The anchor really is in /versions: the guard must let the deploy proceed.
check "paged shape, anchor present"        present 11111111-1111-1111-1111-111111111111 "$paged"
check "paged shape, anchor present at end" present 22222222-2222-2222-2222-222222222222 "$paged"
check "bare-array shape, anchor present"   present 11111111-1111-1111-1111-111111111111 "$bare"
# The anchor is missing: the guard must fire, otherwise we would deploy without
# a recoverable rollback target.
check "paged shape, anchor absent"         absent  99999999-9999-9999-9999-999999999999 "$paged"
check "bare-array shape, anchor absent"    absent  99999999-9999-9999-9999-999999999999 "$bare"
check "no versions at all"                 absent  11111111-1111-1111-1111-111111111111 "$empty"

exit "$fail"
