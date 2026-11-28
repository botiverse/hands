#!/bin/sh
# Rebuilds zucchini-gen.cjs (the Zucchini patch generator as WebAssembly,
# embedded in one Node script) from the vendored sources. CI checks that the
# committed file matches a rebuild with this exact Emscripten version.
set -eu
EMSCRIPTEN_VERSION=7.0.1
here=$(cd "$(dirname "$0")" && pwd)
shared="$here/../../../clients/android/src/main/cpp/zucchini"
if ! em++ --version | head -1 | grep -q " $EMSCRIPTEN_VERSION "; then
  echo "build.sh needs Emscripten $EMSCRIPTEN_VERSION (em++ --version)" >&2
  exit 1
fi
cd "$here"
# Shared with the Android SDK's applier, plus the generator-only files in src/.
set -- \
  address_translator buffer_sink buffer_source crc32 disassembler disassembler_no_op \
  element_detection equivalence_map image_index patch_reader reference_set target_pool \
  zucchini_apply targets_affinity encoded_view disassembler_dex disassembler_elf reloc_elf \
  rel32_finder rel32_utils arm_utils abs32_utils
sources=
for name in "$@"; do sources="$sources $shared/components/zucchini/$name.cc"; done
for name in zucchini_gen patch_writer binary_data_histogram ensemble_matcher \
    heuristic_ensemble_matcher imposed_ensemble_matcher; do
  sources="$sources src/components/zucchini/$name.cc"
done
# shellcheck disable=SC2086
em++ -std=c++20 -O3 -DNDEBUG -w \
  -DZUCCHINI_ENABLE_DEX=1 -DZUCCHINI_ENABLE_ELF=1 -DZUCCHINI_ENABLE_GENERATOR=1 \
  -I src -I "$shared" -I "$shared/shim" \
  -fexceptions -ffile-prefix-map="$here/../../..=." \
  $sources hands_zucchini_gen.cc \
  -sENVIRONMENT=node -sNODERAWFS=1 -sEXIT_RUNTIME=1 -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB \
  -o zucchini-gen.cjs
