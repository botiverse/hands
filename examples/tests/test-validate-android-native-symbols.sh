#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="$root/scripts/validate-android-native-symbols.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/apk/lib/x86_64" "$work/symbols/x86_64"
cat > "$work/handscrash.c" <<'C'
int hands_crash_fixture(int value) { return value + 42; }
C
gcc -shared -fPIC -g -Wl,--build-id=sha1 -o "$work/symbols/x86_64/libhandscrash.so" "$work/handscrash.c"
cp "$work/symbols/x86_64/libhandscrash.so" "$work/apk/lib/x86_64/libhandscrash.so"
objcopy --strip-debug "$work/apk/lib/x86_64/libhandscrash.so"

build_id="$(readelf -n "$work/symbols/x86_64/libhandscrash.so" | awk '/Build ID:/ {print $3; exit}')"
sha="$(sha256sum "$work/symbols/x86_64/libhandscrash.so" | awk '{print $1}')"
cat > "$work/symbols/manifest.json" <<JSON
{"sdk_version":"test","soname":"libhandscrash.so","abis":{"x86_64":{"build_id":"$build_id","sha256":"$sha"}},"source":{"repo":"https://github.com/botiverse/hands","commit":"fixture"}}
JSON

python3 - "$work" <<'PY'
import os
import sys
import zipfile

root = sys.argv[1]
for source, output in (("apk", "app.apk"), ("symbols", "symbols.zip")):
    with zipfile.ZipFile(os.path.join(root, output), "w") as archive:
        base = os.path.join(root, source)
        for current, _, files in os.walk(base):
            for filename in sorted(files):
                path = os.path.join(current, filename)
                archive.write(path, os.path.relpath(path, base))
with zipfile.ZipFile(os.path.join(root, "plain.apk"), "w") as archive:
    archive.writestr("AndroidManifest.xml", b"fixture")
PY

expect_fail() {
  local label="$1"
  shift
  if "$@" >"$work/$label.out" 2>&1; then
    echo "expected failure: $label" >&2
    cat "$work/$label.out" >&2
    exit 1
  fi
}

"$validator" --apk "$work/app.apk" --symbols "$work/symbols.zip" --policy required
expect_fail missing "$validator" --apk "$work/app.apk" --policy auto
"$validator" --apk "$work/plain.apk" --policy auto
expect_fail required-without-library "$validator" --apk "$work/plain.apk" --policy required

mkdir -p "$work/stripped-symbols/x86_64"
cp "$work/apk/lib/x86_64/libhandscrash.so" "$work/stripped-symbols/x86_64/libhandscrash.so"
stripped_sha="$(sha256sum "$work/stripped-symbols/x86_64/libhandscrash.so" | awk '{print $1}')"
cat > "$work/stripped-symbols/manifest.json" <<JSON
{"sdk_version":"test","soname":"libhandscrash.so","abis":{"x86_64":{"build_id":"$build_id","sha256":"$stripped_sha"}},"source":{"repo":"https://github.com/botiverse/hands","commit":"fixture"}}
JSON
python3 - "$work/stripped-symbols" "$work/stripped-symbols.zip" <<'PY'
import os
import sys
import zipfile

base, output = sys.argv[1:]
with zipfile.ZipFile(output, "w") as archive:
    for current, _, files in os.walk(base):
        for filename in sorted(files):
            path = os.path.join(current, filename)
            archive.write(path, os.path.relpath(path, base))
PY
expect_fail stripped "$validator" --apk "$work/app.apk" --symbols "$work/stripped-symbols.zip" --policy required

mkdir -p "$work/mismatch/x86_64"
cat > "$work/other.c" <<'C'
int other_fixture(int value) { return value + 99; }
C
gcc -shared -fPIC -g -Wl,--build-id=sha1 -o "$work/mismatch/x86_64/libhandscrash.so" "$work/other.c"
other_id="$(readelf -n "$work/mismatch/x86_64/libhandscrash.so" | awk '/Build ID:/ {print $3; exit}')"
other_sha="$(sha256sum "$work/mismatch/x86_64/libhandscrash.so" | awk '{print $1}')"
cat > "$work/mismatch/manifest.json" <<JSON
{"sdk_version":"test","soname":"libhandscrash.so","abis":{"x86_64":{"build_id":"$other_id","sha256":"$other_sha"}},"source":{"repo":"https://github.com/botiverse/hands","commit":"fixture-other"}}
JSON
python3 - "$work/mismatch" "$work/mismatch.zip" <<'PY'
import os
import sys
import zipfile

base, output = sys.argv[1:]
with zipfile.ZipFile(output, "w") as archive:
    for current, _, files in os.walk(base):
        for filename in sorted(files):
            path = os.path.join(current, filename)
            archive.write(path, os.path.relpath(path, base))
PY
expect_fail mismatch "$validator" --apk "$work/app.apk" --symbols "$work/mismatch.zip" --policy required

mkdir -p "$work/bin"
cat > "$work/bin/hands" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$HANDS_ARGS_LOG"
SH
chmod +x "$work/bin/hands"
export HANDS_ARGS_LOG="$work/hands-args.txt"
HANDS_BEARER_TOKEN=fixture PATH="$work/bin:$PATH" \
  "$root/scripts/publish-android.sh" \
    --app fixture \
    --apk "$work/app.apk" \
    --channel preview \
    --version-name 1.0.0 \
    --version-code 1000000 \
    --symbols "$work/symbols.zip" \
    --native-symbols-policy required
grep -Fx -- '--symbols' "$HANDS_ARGS_LOG" >/dev/null
grep -Fx -- "$work/symbols.zip" "$HANDS_ARGS_LOG" >/dev/null
grep -Fx -- '--draft' "$HANDS_ARGS_LOG" >/dev/null

echo "Android native-symbol validation fixtures passed."
