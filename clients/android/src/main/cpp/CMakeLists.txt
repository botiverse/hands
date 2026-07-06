cmake_minimum_required(VERSION 3.22.1)
project(quivercrash C)

add_library(quivercrash SHARED quiver_native_crash.c)
target_compile_options(quivercrash PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
# JNIEXPORT carries default visibility, so the entry point stays exported.
