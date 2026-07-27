cmake_minimum_required(VERSION 3.22.1)
project(handscrash C)

add_library(handscrash SHARED hands_native_crash.c hands_record_file.c)
target_compile_options(handscrash PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
# NDK r26 defaults to 4 KB PT_LOAD alignment. Keep the supported r26 toolchain
# while emitting one binary that can load on both 4 KB and 16 KB Android.
target_link_options(handscrash PRIVATE "-Wl,-z,max-page-size=16384")
# JNIEXPORT carries default visibility, so the entry point stays exported.
