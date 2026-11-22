#!/usr/bin/env bash
# Publish a signed Android APK to Hands from any CI.
# Env: HANDS_BEARER_TOKEN (deploy token), HANDS_APP_SLUG, APK_PATH,
#      VERSION_NAME, VERSION_CODE, optional HANDS_CHANNEL (default preview),
#      NATIVE_SYMBOLS_PATH, MAPPING_PATH, HANDS_NATIVE_SYMBOLS_POLICY.
# Keep this file beside the repository's scripts/ directory; the canonical
# publisher validates APK/native-symbol build IDs before uploading.
set -euo pipefail
: "${HANDS_BEARER_TOKEN:?}" "${HANDS_APP_SLUG:?}" "${APK_PATH:?}" "${VERSION_NAME:?}" "${VERSION_CODE:?}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git log --no-merges --pretty='- %s' -15 > changelog.txt 2>/dev/null || echo "- release ${VERSION_NAME}" > changelog.txt
args=(
  --app "$HANDS_APP_SLUG"
  --apk "$APK_PATH"
  --channel "${HANDS_CHANNEL:-preview}"
  --version-name "$VERSION_NAME"
  --version-code "$VERSION_CODE"
  --changelog ./changelog.txt
  --native-symbols-policy "${HANDS_NATIVE_SYMBOLS_POLICY:-auto}"
)
test -z "${NATIVE_SYMBOLS_PATH:-}" || args+=(--symbols "$NATIVE_SYMBOLS_PATH")
test -z "${MAPPING_PATH:-}" || args+=(--mapping "$MAPPING_PATH")
"${repo_root}/scripts/publish-android.sh" "${args[@]}"
