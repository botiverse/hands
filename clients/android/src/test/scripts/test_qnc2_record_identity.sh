#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

cc -std=c11 -Wall -Wextra -Werror \
  -I"$root/main/cpp" \
  "$root/main/cpp/hands_record_file.c" \
  "$root/test/cpp/hands_record_file_test.c" \
  -o "$tmp/hands_record_file_test"
"$tmp/hands_record_file_test" "$tmp"
