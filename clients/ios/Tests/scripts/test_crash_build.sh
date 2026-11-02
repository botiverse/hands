#!/usr/bin/env bash
# Host test for the iOS SDK's async-signal-safe crashed-build buffers
# (Sources/Hands/HandsCrashBuild.c). Needs only a C compiler; no Xcode.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

cc -std=c11 -Wall -Wextra -Werror \
  -I"$root/Sources/Hands" \
  "$root/Sources/Hands/HandsCrashBuild.c" \
  "$root/Tests/c/hands_crash_build_test.c" \
  -o "$tmp/hands_crash_build_test"
"$tmp/hands_crash_build_test"
