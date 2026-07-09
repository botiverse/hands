cmake_minimum_required(VERSION 3.22.1)
project(handscrash C)

add_library(handscrash SHARED hands_native_crash.c)
target_compile_options(handscrash PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
# JNIEXPORT carries default visibility, so the entry point stays exported.
