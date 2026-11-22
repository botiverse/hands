#!/usr/bin/env bash
# Publish a signed iOS IPA (+ dSYM) to Hands from any CI.
# TestFlight uploads happen server-side in Hands afterwards — no ASC keys here.
# Env: HANDS_BEARER_TOKEN, HANDS_APP_SLUG, IPA_PATH, DSYM_PATH,
#      VERSION_NAME, VERSION_CODE, optional HANDS_CHANNEL (default main).
set -euo pipefail
: "${HANDS_BEARER_TOKEN:?}" "${HANDS_APP_SLUG:?}" "${IPA_PATH:?}" "${VERSION_NAME:?}" "${VERSION_CODE:?}"
npm install -g @botiverse/hands-cli@0.5.1 >/dev/null
git log --no-merges --pretty='- %s' -15 > changelog.txt 2>/dev/null || echo "- release ${VERSION_NAME}" > changelog.txt
ARGS=(
  --ipa "${IPA_PATH}"
  --channel "${HANDS_CHANNEL:-main}"
  --version-name "${VERSION_NAME}"
  --version-code "${VERSION_CODE}"
  --changelog-file ./changelog.txt
  --export-method app-store
  --draft
)
if [ -n "${DSYM_PATH:-}" ]; then ARGS+=(--dsym "${DSYM_PATH}"); fi
hands builds publish-ios "${HANDS_APP_SLUG}" "${ARGS[@]}"
