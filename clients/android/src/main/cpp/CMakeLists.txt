cmake_minimum_required(VERSION 3.22.1)
project(handscrash C)

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

add_library(handscrash SHARED hands_native_crash.c hands_record_file.c hands_zlib_deflater.c)
target_link_libraries(handscrash PRIVATE handszlib)
target_compile_options(handscrash PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
# NDK r26 defaults to 4 KB PT_LOAD alignment. Keep the supported r26 toolchain
# while emitting one binary that can load on both 4 KB and 16 KB Android.
target_link_options(handscrash PRIVATE "-Wl,-z,max-page-size=16384")
# JNIEXPORT carries default visibility, so the entry point stays exported.
