#!/usr/bin/env bash
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRADLE_BIN="${GRADLE_BIN:-gradle}"
SDK_VERSION="${HANDS_ANDROID_SDK_TEST_VERSION:-0.12.4}"

command -v "${GRADLE_BIN}" >/dev/null 2>&1 || {
  echo "error: ${GRADLE_BIN} is required" >&2
  exit 1
}

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
symbols_archive="${ROOT_DIR}/clients/android/build/outputs/native-symbols/hands-android-sdk-${SDK_VERSION}-native-symbols.zip"
source_commit="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
publish_workflow="${ROOT_DIR}/.github/workflows/publish-android-sdk.yml"
version_expression='${{ github.event.inputs.version }}'

expression_count="$(
  awk -v needle="${version_expression}" '
    index($0, needle) { count += 1 }
    END { print count + 0 }
  ' "${publish_workflow}"
)"
[[ "${expression_count}" == "1" ]] || {
  echo "workflow dispatch version must have exactly one expression boundary" >&2
  exit 1
}
grep -Eq '^[[:space:]]*INPUT_VERSION:[[:space:]]*\$\{\{ github\.event\.inputs\.version \}\}[[:space:]]*$' \
  "${publish_workflow}" || {
  echo "workflow dispatch version must enter the shell through step env" >&2
  exit 1
}
grep -Fq 'VERSION="${INPUT_VERSION}"' "${publish_workflow}" || {
  echo "version resolver does not read the env-bound workflow input" >&2
  exit 1
}

if "${GRADLE_BIN}" -p "${ROOT_DIR}/clients/android" validatePublicationVersion \
  --no-daemon --console=plain >"${work_dir}/missing-version.log" 2>&1; then
  echo "publication version gate accepted a missing VERSION_NAME" >&2
  exit 1
fi
grep -Fq "Refusing Maven publication without -PVERSION_NAME" \
  "${work_dir}/missing-version.log"

"${GRADLE_BIN}" -p "${ROOT_DIR}/clients/android" publishToMavenLocal \
  --dry-run --no-daemon --console=plain -PVERSION_NAME="${SDK_VERSION}" \
  >"${work_dir}/local.log"
"${GRADLE_BIN}" -p "${ROOT_DIR}/clients/android" publish \
  --dry-run --no-daemon --console=plain -PVERSION_NAME="${SDK_VERSION}" \
  >"${work_dir}/remote.log"

for task in \
  validatePublicationVersion \
  testAndroidElfVerifier \
  verifyReleaseAarElfAlignment \
  verifyReleaseNativeSymbolsElfAlignment \
  verifyReleaseElfAlignment; do
  grep -Fq ":${task} SKIPPED" "${work_dir}/local.log" || {
    echo "local Maven publication bypasses ${task}" >&2
    exit 1
  }
  grep -Fq ":${task} SKIPPED" "${work_dir}/remote.log" || {
    echo "remote Maven publication bypasses ${task}" >&2
    exit 1
  }
done

grep -Fq ":publishReleasePublicationToMavenLocal SKIPPED" \
  "${work_dir}/local.log"
grep -Fq ":publishReleasePublicationToGitHubPackagesRepository SKIPPED" \
  "${work_dir}/remote.log"

"${GRADLE_BIN}" -p "${ROOT_DIR}/clients/android" packageReleaseNativeSymbols \
  --no-daemon --console=plain -PVERSION_NAME="${SDK_VERSION}" \
  >"${work_dir}/package-first.log"
cp "${symbols_archive}" "${work_dir}/symbols-first.zip"
"${GRADLE_BIN}" -p "${ROOT_DIR}/clients/android" packageReleaseNativeSymbols \
  --no-daemon --console=plain -PVERSION_NAME="${SDK_VERSION}" \
  >"${work_dir}/package-second.log"
cmp "${work_dir}/symbols-first.zip" "${symbols_archive}"

python3 "${ROOT_DIR}/scripts/verify_android_elf_alignment.py" \
  --archive "${symbols_archive}" >"${work_dir}/symbols-verifier.json"

python3 - "${ROOT_DIR}" "${symbols_archive}" "${work_dir}" <<'PY'
import sys
import zipfile
from pathlib import Path

root, symbols_path, work_dir = map(Path, sys.argv[1:])
sys.path.insert(0, str(root / "scripts"))
from verify_android_elf_alignment import verify_archive

library_names = (
    "arm64-v8a/libhandscrash.so",
    "x86_64/libhandscrash.so",
)
with zipfile.ZipFile(symbols_path) as source:
    libraries = {name: source.read(name) for name in library_names}

for target_name, truncated_size in (
    (library_names[0], 1024),
    (library_names[1], 4096),
):
    output = work_dir / f"truncated-{target_name.split('/', 1)[0]}.zip"
    with zipfile.ZipFile(output, "w") as archive:
        for name, data in libraries.items():
            archive.writestr(
                name,
                data[:truncated_size] if name == target_name else data,
            )
    try:
        verify_archive(output)
    except ValueError as error:
        if "exceeds file bounds" not in str(error):
            raise SystemExit(
                f"real {target_name} truncation failed for the wrong reason: {error}"
            ) from error
    else:
        raise SystemExit(f"verifier accepted truncated real ELF: {target_name}")
PY

python3 - "${symbols_archive}" "${SDK_VERSION}" "${source_commit}" <<'PY'
import json
import sys
import zipfile

archive_path, expected_version, expected_commit = sys.argv[1:]
with zipfile.ZipFile(archive_path) as archive:
    manifest = json.loads(archive.read("manifest.json"))
if manifest.get("sdk_version") != expected_version:
    raise SystemExit("native-symbols manifest version does not match VERSION_NAME")
if manifest.get("source", {}).get("commit") != expected_commit:
    raise SystemExit("native-symbols manifest source does not match HEAD")
PY

echo "Android SDK publication gate contract: PASS"
