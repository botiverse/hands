#!/usr/bin/env bash
# Publish a signed multi-platform Tauri v2 draft from any CI.
#
# Required env:
#   HANDS_BEARER_TOKEN, HANDS_APP_SLUG, VERSION
#   TAURI_BUNDLES: newline-separated target=path entries, for example:
#     darwin-aarch64=dist/Raft.app.tar.gz
#     linux-x86_64=dist/Raft.AppImage
#     windows-x86_64=dist/Raft-setup.exe
# Each bundle must have an adjacent <bundle>.sig file.
# Optional env: HANDS_CHANNEL (default main), CHANGELOG_PATH.
set -euo pipefail

: "${HANDS_BEARER_TOKEN:?}" "${HANDS_APP_SLUG:?}" "${VERSION:?}" "${TAURI_BUNDLES:?}"

npm install -g @botiverse/hands-cli@0.5.9 >/dev/null

if [ -n "${CHANGELOG_PATH:-}" ]; then
  changelog="$CHANGELOG_PATH"
else
  changelog="$(mktemp)"
  trap 'rm -f "$changelog"' EXIT
  git log --no-merges --pretty='- %s' -15 > "$changelog" 2>/dev/null || printf '%s\n' "- release ${VERSION}" > "$changelog"
fi

ARGS=(
  --version-name "$VERSION"
  --channel "${HANDS_CHANNEL:-main}"
  --changelog-file "$changelog"
)

while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  target="${entry%%=*}"
  bundle="${entry#*=}"
  if [ "$target" = "$entry" ] || [ -z "$bundle" ]; then
    printf 'invalid TAURI_BUNDLES entry: %s\n' "$entry" >&2
    exit 2
  fi
  test -f "$bundle"
  test -f "${bundle}.sig"
  ARGS+=(--bundle "$bundle" --signature "${bundle}.sig" --target "$target")
done <<< "$TAURI_BUNDLES"

hands builds publish-tauri "$HANDS_APP_SLUG" "${ARGS[@]}"
