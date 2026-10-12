# Adapter for opusic-sys' bundled Opus build under Bazel.
#
# rules_android_ndk exports the NDK's Clang toolchain and sysroot, but not the
# NDK's build/cmake metadata consumed by its upstream android.toolchain.cmake.
# CMake's legacy Android mode avoids rediscovering that missing metadata; the
# Bazel-selected compiler flags still target API 24 and the declared NDK sysroot
# below supplies Android headers and libraries.
set(CMAKE_SYSTEM_NAME Android)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_ANDROID_ARCH_ABI arm64-v8a)
set(CMAKE_ANDROID_API 24)

set(_OMP_ANDROID_SYSROOT "$ENV{ANDROID_NDK_ROOT}/toolchains/llvm/prebuilt/linux-x86_64/sysroot")
set(CMAKE_SYSROOT "${_OMP_ANDROID_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH "${_OMP_ANDROID_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
