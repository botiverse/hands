#!/usr/bin/env bash
# Publish ONE platform's Electron installer to Hands from any CI. Run once per
# platform, each into its own platform channel (e.g. main-win32/main-darwin/
# main-linux) so activations never supersede another platform's release.
# Channels are not auto-created: create them in the Hands Console first.
# Env: HANDS_BEARER_TOKEN, HANDS_APP_SLUG, VERSION_NAME, VERSION_CODE,
#      PLATFORM (win32|darwin|linux), ARCH, METADATA_PATH (latest*.yml),
#      INSTALLER_PATH, optional BLOCKMAP_PATH, optional HANDS_CHANNEL.
set -euo pipefail
: "${HANDS_BEARER_TOKEN:?}" "${HANDS_APP_SLUG:?}" "${VERSION_NAME:?}" "${VERSION_CODE:?}"
: "${PLATFORM:?}" "${ARCH:?}" "${METADATA_PATH:?}" "${INSTALLER_PATH:?}"
npm install -g @botiverse/hands-cli@0.5.1 >/dev/null
git log --no-merges --pretty='- %s' -15 > changelog.txt 2>/dev/null || echo "- release ${VERSION_NAME}" > changelog.txt
ARGS=(
  --channel "${HANDS_CHANNEL:-main-${PLATFORM}}"
  --version-name "${VERSION_NAME}"
  --version-code "${VERSION_CODE}"
  --platform "${PLATFORM}"
  --arch "${ARCH}"
  --metadata "${METADATA_PATH}"
  --installer "${INSTALLER_PATH}"
  --changelog-file ./changelog.txt
  --draft
)
if [ -n "${BLOCKMAP_PATH:-}" ]; then ARGS+=(--blockmap "${BLOCKMAP_PATH}"); fi
hands builds publish-electron "${HANDS_APP_SLUG}" "${ARGS[@]}"
