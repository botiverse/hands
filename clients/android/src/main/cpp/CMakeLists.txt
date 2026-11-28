cmake_minimum_required(VERSION 3.22.1)
project(handscrash C CXX)

# Stock zlib 1.3.1 deflate (see zlib/README.hands). Delta APK updates must
# recompress exactly like the server's stock zlib, which the platform libz
# (Chromium's fork since Android 12) does not. Z_PREFIX renames every zlib
# symbol (z_deflate, ...) and hidden visibility keeps them out of the dynamic
# symbol table, so nothing clashes with or is interposed by the system libz.
# Upstream code is built as-is, so its warnings are not our -Werror's concern.
add_library(handszlib OBJECT
    zlib/adler32.c
    zlib/crc32.c
    zlib/deflate.c
    zlib/trees.c
    zlib/zutil.c)
target_compile_definitions(handszlib PUBLIC Z_PREFIX)
target_compile_options(handszlib PRIVATE -fvisibility=hidden -w)
set_target_properties(handszlib PROPERTIES POSITION_INDEPENDENT_CODE ON)

# Zucchini patch applier (see zucchini/README.hands): apply-only, DEX and ELF
# disassemblers. Exceptions stay on so a failed internal CHECK throws to the
# JNI entry point instead of aborting the host app.
set(ZUCCHINI_DIR ${CMAKE_CURRENT_SOURCE_DIR}/zucchini)
set(ZUCCHINI_SOURCES
    address_translator.cc buffer_sink.cc buffer_source.cc crc32.cc
    disassembler.cc disassembler_no_op.cc element_detection.cc
    equivalence_map.cc image_index.cc patch_reader.cc
    reference_set.cc target_pool.cc zucchini_apply.cc targets_affinity.cc
    encoded_view.cc zucchini_capi.cc
    disassembler_dex.cc
    disassembler_elf.cc reloc_elf.cc rel32_finder.cc rel32_utils.cc arm_utils.cc
    abs32_utils.cc)
list(TRANSFORM ZUCCHINI_SOURCES PREPEND ${ZUCCHINI_DIR}/components/zucchini/)
add_library(handszucchini OBJECT ${ZUCCHINI_SOURCES})
target_include_directories(handszucchini PUBLIC ${ZUCCHINI_DIR} ${ZUCCHINI_DIR}/shim)
target_compile_definitions(handszucchini PUBLIC ZUCCHINI_ENABLE_DEX=1 ZUCCHINI_ENABLE_ELF=1 NDEBUG)
target_compile_features(handszucchini PUBLIC cxx_std_20)
target_compile_options(handszucchini PRIVATE -fvisibility=hidden -Oz -ffunction-sections -fdata-sections -fexceptions -fno-rtti -w)
set_target_properties(handszucchini PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(handscrash SHARED hands_native_crash.c hands_record_file.c hands_zlib_deflater.c hands_zucchini.cc)
target_link_libraries(handscrash PRIVATE handszlib handszucchini)
set_source_files_properties(hands_zucchini.cc PROPERTIES COMPILE_OPTIONS "-fexceptions;-fno-rtti")
target_compile_options(handscrash PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
# NDK r26 defaults to 4 KB PT_LOAD alignment. Keep the supported r26 toolchain
# while emitting one binary that can load on both 4 KB and 16 KB Android.
target_link_options(handscrash PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,--gc-sections" "-Wl,--exclude-libs,ALL")
# JNIEXPORT carries default visibility, so the entry point stays exported.
