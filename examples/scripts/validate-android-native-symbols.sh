#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: validate-android-native-symbols.sh --apk FILE [--symbols FILE] \
  [--policy auto|required|disabled]

Policies:
  auto      Require exact symbols when the APK contains libhandscrash.so.
  required  Always require and validate the Hands native-symbols archive.
  disabled  Allow a missing archive, but still validate one when supplied.

The archive must be the native-symbols classifier from the same Maven channel
and SDK build as the AAR packaged into the APK. Repacking stripped APK/AAR
libraries is not a valid substitute.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 64
}

apk=""
symbols=""
policy="auto"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apk) apk="$2"; shift 2 ;;
    --symbols) symbols="$2"; shift 2 ;;
    --policy) policy="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

test -s "$apk" || die "APK not found or empty: $apk"
case "$policy" in
  auto|required|disabled) ;;
  *) die "policy must be auto, required, or disabled" ;;
esac
if [ -n "$symbols" ]; then
  test -s "$symbols" || die "native symbols archive not found or empty: $symbols"
fi

find_readelf() {
  local candidate
  for candidate in \
    "${HANDS_LLVM_READELF:-}" \
    "${ANDROID_NDK_ROOT:-}/toolchains/llvm/prebuilt"/*/bin/llvm-readelf \
    "${ANDROID_HOME:-}/ndk"/*/toolchains/llvm/prebuilt/*/bin/llvm-readelf \
    llvm-readelf \
    readelf; do
    test -n "$candidate" || continue
    if [[ "$candidate" == */* ]]; then
      test -x "$candidate" && printf '%s\n' "$candidate" && return 0
    elif command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
apk_entries="$work/apk-entries.txt"
unzip -Z1 "$apk" | grep -E '^(lib|jni)/[^/]+/libhandscrash\.so$' | sort -u > "$apk_entries" || true

if [ ! -s "$apk_entries" ]; then
  if [ "$policy" = "required" ]; then
    die "APK does not contain libhandscrash.so but native symbols are required"
  fi
  if [ -n "$symbols" ]; then
    die "symbols were supplied, but the APK does not contain libhandscrash.so"
  fi
  echo "APK does not contain libhandscrash.so; Hands native symbols are not required."
  exit 0
fi

if [ -z "$symbols" ]; then
  if [ "$policy" = "disabled" ]; then
    echo "warning: APK contains libhandscrash.so, but native symbol validation is explicitly disabled" >&2
    exit 0
  fi
  die "APK contains libhandscrash.so; provide its exact native-symbols classifier archive"
fi

readelf="$(find_readelf)" || die "llvm-readelf/readelf not found"
mkdir -p "$work/symbols"
unzip -q "$symbols" -d "$work/symbols"
manifest="$work/symbols/manifest.json"
test -f "$manifest" || die "manifest.json missing from symbols archive"

python3 - "$manifest" "$work/manifest.tsv" <<'PY'
import json
import sys

manifest_path, output_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    payload = json.load(handle)
if payload.get("soname") != "libhandscrash.so":
    raise SystemExit("manifest soname must be libhandscrash.so")
if not payload.get("sdk_version"):
    raise SystemExit("manifest sdk_version is required")
source = payload.get("source") or {}
if source.get("repo") != "https://github.com/botiverse/hands" or not source.get("commit"):
    raise SystemExit("manifest source repo/commit is invalid")
abis = payload.get("abis") or {}
if not abis:
    raise SystemExit("manifest abis must not be empty")
with open(output_path, "w", encoding="utf-8") as handle:
    for arch, item in sorted(abis.items()):
        build_id = item.get("build_id", "")
        sha256 = item.get("sha256", "")
        if not build_id or not sha256:
            raise SystemExit(f"manifest ABI {arch} is missing build_id or sha256")
        handle.write(f"{arch}\t{build_id}\t{sha256}\n")
PY

count=0
while IFS= read -r apk_entry; do
  arch="$(printf '%s' "$apk_entry" | cut -d/ -f2)"
  apk_so="$work/apk/$arch/libhandscrash.so"
  symbol_so="$work/symbols/$arch/libhandscrash.so"
  mkdir -p "$(dirname "$apk_so")"
  unzip -qp "$apk" "$apk_entry" > "$apk_so"
  test -f "$symbol_so" || die "symbols archive does not cover APK ABI $arch"

  apk_id="$($readelf -n "$apk_so" | awk '/Build ID:/ {print $3; exit}')"
  symbol_id="$($readelf -n "$symbol_so" | awk '/Build ID:/ {print $3; exit}')"
  manifest_id="$(awk -F '\t' -v arch="$arch" '$1 == arch {print $2}' "$work/manifest.tsv")"
  manifest_sha="$(awk -F '\t' -v arch="$arch" '$1 == arch {print $3}' "$work/manifest.tsv")"
  actual_sha="$(sha256_file "$symbol_so")"

  test -n "$apk_id" || die "APK libhandscrash.so has no build ID for $arch"
  test "$apk_id" = "$symbol_id" || die "build ID mismatch for $arch: apk=$apk_id symbols=$symbol_id"
  test "$symbol_id" = "$manifest_id" || die "manifest build ID mismatch for $arch"
  test "$actual_sha" = "$manifest_sha" || die "manifest sha256 mismatch for $arch"
  if ! "$readelf" -S "$symbol_so" | awk '/\.debug_info/ { found=1 } END { exit(found ? 0 : 1) }'; then
    die "symbol file is stripped for $arch"
  fi
  count=$((count + 1))
done < "$apk_entries"

echo "Verified $count Hands native symbol file(s) against APK build IDs."
