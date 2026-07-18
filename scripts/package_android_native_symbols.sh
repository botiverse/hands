#!/usr/bin/env bash
set -euo pipefail

BUILD_DIR=""
OUTPUT=""
SDK_VERSION=""

die() {
  echo "error: $*" >&2
  exit 64
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-dir)
      [ "$#" -ge 2 ] || die "--build-dir requires a value"
      BUILD_DIR="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || die "--output requires a value"
      OUTPUT="$2"
      shift 2
      ;;
    --sdk-version)
      [ "$#" -ge 2 ] || die "--sdk-version requires a value"
      SDK_VERSION="$2"
      shift 2
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[ -n "$BUILD_DIR" ] || die "--build-dir is required"
[ -n "$OUTPUT" ] || die "--output is required"
[ -n "$SDK_VERSION" ] || die "--sdk-version is required"
[ -d "$BUILD_DIR/intermediates/cxx" ] || die "missing release CMake intermediates under $BUILD_DIR"

find_readelf() {
  local candidate
  for candidate in \
    "${HANDS_LLVM_READELF:-}" \
    "${ANDROID_NDK_ROOT:-}/toolchains/llvm/prebuilt"/*/bin/llvm-readelf \
    "${ANDROID_HOME:-}/ndk"/*/toolchains/llvm/prebuilt/*/bin/llvm-readelf \
    llvm-readelf \
    readelf; do
    [ -n "$candidate" ] || continue
    if [[ "$candidate" == */* ]]; then
      [ -x "$candidate" ] && printf '%s\n' "$candidate" && return 0
    elif command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

READELF="$(find_readelf)" || die "llvm-readelf/readelf not found"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
MANIFEST_ROWS="$STAGE/manifest-rows.tsv"
printf 'arch\tbuild_id\tsha256\n' > "$MANIFEST_ROWS"

count=0
seen_arches=""
while IFS= read -r so; do
  arch="$(basename "$(dirname "$so")")"
  module="$(basename "$so")"
  case "|$seen_arches|" in
    *"|$arch|"*) die "multiple native symbol candidates found for ABI $arch; clean the SDK build first" ;;
  esac
  seen_arches="${seen_arches}|${arch}"
  build_id="$($READELF -n "$so" | awk '/Build ID:/ {print $3; exit}')"
  [ -n "$build_id" ] || die "missing build ID: $so"
  if ! "$READELF" -S "$so" | awk '/\.debug_info/ { found=1 } END { exit(found ? 0 : 1) }'; then
    die "refusing stripped native symbol file without .debug_info: $so"
  fi
  mkdir -p "$STAGE/$arch"
  cp -p "$so" "$STAGE/$arch/$module"
  sha="$(sha256sum "$so" | awk '{print $1}')"
  printf '%s\t%s\t%s\n' "$arch" "$build_id" "$sha" >> "$MANIFEST_ROWS"
  count=$((count + 1))
done < <(find "$BUILD_DIR/intermediates/cxx" -type f -path '*/obj/*/libhandscrash.so' | sort)

[ "$count" -eq 3 ] || die "expected 3 SDK ABIs, found $count"
for required_arch in arm64-v8a armeabi-v7a x86_64; do
  case "|$seen_arches|" in
    *"|$required_arch|"*) ;;
    *) die "missing native symbols for ABI $required_arch" ;;
  esac
done
SOURCE_COMMIT="$(git -C "$(dirname "$0")/.." rev-parse HEAD)"
python3 - "$SDK_VERSION" "$SOURCE_COMMIT" "$MANIFEST_ROWS" "$STAGE/manifest.json" <<'PY'
import csv
import json
import sys

sdk_version, source_commit, rows_path, output_path = sys.argv[1:]
abis = {}
with open(rows_path, newline="", encoding="utf-8") as handle:
    for row in csv.DictReader(handle, delimiter="\t"):
        abis[row["arch"]] = {
            "build_id": row["build_id"],
            "sha256": row["sha256"],
        }
payload = {
    "sdk_version": sdk_version,
    "soname": "libhandscrash.so",
    "abis": abis,
    "source": {
        "repo": "https://github.com/botiverse/hands",
        "commit": source_commit,
    },
}
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
mkdir -p "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
rm -f "$OUTPUT"
(
  cd "$STAGE"
  zip -X -qr "$OUTPUT" manifest.json arm64-v8a armeabi-v7a x86_64
)
echo "Packaged $count unstripped Hands Android native symbol files: $OUTPUT"
