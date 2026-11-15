# Copyright 2014 The BoringSSL Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

cmake_minimum_required(VERSION 3.22)

# Defer enabling C and CXX languages.
project(BoringSSL NONE)

# Don't install BoringSSL to system directories by default; it has no stable
# ABI. Instead, default to an "install" directory under the source.
if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
  set(CMAKE_INSTALL_PREFIX ${CMAKE_SOURCE_DIR}/install CACHE PATH "" FORCE)
endif()

if(WIN32)
  # On Windows, prefer cl over gcc if both are available. By default most of
  # the CMake generators prefer gcc, even on Windows.
  set(CMAKE_GENERATOR_CC cl)
endif()

include(cmake/go.cmake)
include(cmake/paths.cmake)
include(gen/sources.cmake)

enable_language(C)
enable_language(CXX)

# TODO(crbug,com/389897612): Register tests with CTest. For now, we include this
# only to pick up the standard |BUILD_TESTING| option.
include(CTest)
include(GNUInstallDirs)

set(INSTALL_ENABLED 1)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND NOT CMAKE_CROSSCOMPILING AND
   BUILD_TESTING)
  find_package(PkgConfig QUIET)
  if (PkgConfig_FOUND)
    pkg_check_modules(LIBUNWIND libunwind-generic>=1.3.0)
    if(LIBUNWIND_FOUND)
      add_definitions(-DBORINGSSL_HAVE_LIBUNWIND)
    else()
      message("libunwind not found. Disabling unwind tests.")
    endif()
  else()
    message("pkgconfig not found. Disabling unwind tests.")
  endif()
endif()

string(TOLOWER "${CMAKE_BUILD_TYPE}" CMAKE_BUILD_TYPE_LOWER)
if(NOT FIPS)
  if(CMAKE_BUILD_TYPE_LOWER STREQUAL "relwithassert" OR
     NOT CMAKE_BUILD_TYPE_LOWER MATCHES "rel")
    add_definitions(-DBORINGSSL_DISPATCH_TEST)
    # CMake automatically connects include_directories to the NASM
    # command-line, but not add_definitions.
    set(CMAKE_ASM_NASM_FLAGS "${CMAKE_ASM_NASM_FLAGS} -DBORINGSSL_DISPATCH_TEST")
  endif()
endif()

# Add a RelWithAsserts build configuration. It is the same as Release, except it
# does not define NDEBUG, so asserts run.
foreach(VAR CMAKE_C_FLAGS CMAKE_CXX_FLAGS CMAKE_ASM_FLAGS)
  string(REGEX REPLACE "(^| )[/-]DNDEBUG( |$)" " " "${VAR}_RELWITHASSERTS"
         "${${VAR}_RELEASE}")
endforeach()

if(BORINGSSL_PREFIX AND BORINGSSL_PREFIX_SYMBOLS)
  require_go()
  add_definitions(-DBORINGSSL_PREFIX=${BORINGSSL_PREFIX})
  # CMake automatically connects include_directories to the NASM command-line,
  # but not add_definitions.
  set(CMAKE_ASM_NASM_FLAGS "${CMAKE_ASM_NASM_FLAGS} -DBORINGSSL_PREFIX=${BORINGSSL_PREFIX}")

  # Use "symbol_prefix_include" to store generated header files
  include_directories(${CMAKE_CURRENT_BINARY_DIR}/symbol_prefix_include)
  add_custom_command(
    OUTPUT symbol_prefix_include/boringssl_prefix_symbols.h
           symbol_prefix_include/boringssl_prefix_symbols_asm.h
           symbol_prefix_include/boringssl_prefix_symbols_nasm.inc
    COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_CURRENT_BINARY_DIR}/symbol_prefix_include
    COMMAND ${GO_EXECUTABLE} run ${CMAKE_CURRENT_SOURCE_DIR}/util/make_prefix_headers.go -out ${CMAKE_CURRENT_BINARY_DIR}/symbol_prefix_include ${BORINGSSL_PREFIX_SYMBOLS}
    DEPENDS util/make_prefix_headers.go
            ${BORINGSSL_PREFIX_SYMBOLS})

  # add_dependencies needs a target, not a file, so we add an intermediate
  # target.
  add_custom_target(
    boringssl_prefix_symbols
    DEPENDS symbol_prefix_include/boringssl_prefix_symbols.h
            symbol_prefix_include/boringssl_prefix_symbols_asm.h
            symbol_prefix_include/boringssl_prefix_symbols_nasm.inc)
elseif(BORINGSSL_PREFIX OR BORINGSSL_PREFIX_SYMBOLS)
  message(FATAL_ERROR "Must specify both or neither of BORINGSSL_PREFIX and BORINGSSL_PREFIX_SYMBOLS")
else()
  add_custom_target(boringssl_prefix_symbols)
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  set(CLANG 1)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(CMAKE_COMPILER_IS_GNUCXX OR CLANG)
  # Note clang-cl is odd and sets both CLANG and MSVC. We base our configuration
  # primarily on our normal Clang one.
  set(C_CXX_FLAGS "-Werror -Wformat=2 -Wmissing-field-initializers -Wshadow -Wsign-compare -Wtype-limits -Wvla -Wwrite-strings -fno-strict-aliasing")
  if(MSVC)
    # clang-cl sets different default warnings than clang. It also treats -Wall
    # as -Weverything, to match MSVC. Instead -W3 is the alias for -Wall.
    # See http://llvm.org/viewvc/llvm-project?view=revision&revision=319116
    set(C_CXX_FLAGS "${C_CXX_FLAGS} -W3 -Wno-unused-parameter -fmsc-version=1900")
  else()
    if(CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
      # emscripten's emcc/clang does not accept the "-ggdb" flag.
      set(C_CXX_FLAGS "${C_CXX_FLAGS} -g")
    else()
      set(C_CXX_FLAGS "${C_CXX_FLAGS} -ggdb")
    endif()

    set(C_CXX_FLAGS "${C_CXX_FLAGS} -Wall -fno-common -fvisibility=hidden")
  endif()

  if(CLANG)
    set(C_CXX_FLAGS "${C_CXX_FLAGS} -Wnewline-eof -Wextra-semi -fcolor-diagnostics")
  else()
    # GCC (at least 4.8.4) has a bug where it'll find unreachable free() calls
    # and declare that the code is trying to free a stack pointer.
    set(C_CXX_FLAGS "${C_CXX_FLAGS} -Wno-free-nonheap-object")
  endif()

  # -Wstring-concatenation was added in Clang 12.0.0, which corresponds to
  # AppleClang 13.0.0 per the table in
  # https://en.wikipedia.org/wiki/Xcode#Toolchain_versions
  if((CMAKE_C_COMPILER_ID STREQUAL "Clang" AND
      CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "12.0.0") OR
     (CMAKE_C_COMPILER_ID STREQUAL "AppleClang" AND
      CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "13.0.0"))
    set(C_CXX_FLAGS "${C_CXX_FLAGS} -Wstring-concatenation")
  endif()

  # Clang 12's -Wframe-larger-than reportedly does not work in clang-cl. See
  # https://crbug.com/boringssl/709. Clang 13 includes the following fix, which
  # may be related. Speculatively gate on Clang 13. That corresponds to
  # AppleClang 13.1.6.
  # https://github.com/llvm/llvm-project/commit/6aaf4fa2885600b0e31042071ad06f78218ab0f2
  if((CMAKE_C_COMPILER_ID STREQUAL "Clang" AND
      CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "13.0.0") OR
     (CMAKE_C_COMPILER_ID STREQUAL "AppleClang" AND
      CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "13.1.6"))
    set(C_CXX_FLAGS "${C_CXX_FLAGS} -Wframe-larger-than=25344")
  endif()

  # -Wctad-maybe-unsupported was added in Clang 10, which is AppleClang 12.0.0.
  if((CMAKE_C_COMPILER_ID STREQUAL "Clang" AND
      CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "10.0.0") OR
     (CMAKE_C_COMPILER_ID STREQUAL "AppleClang" AND
      CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "12.0.0"))
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wctad-maybe-unsupported")
  endif()

  if(CLANG OR CMAKE_C_COMPILER_VERSION VERSION_GREATER_EQUAL "7.0.0")
    set(C_CXX_FLAGS "${C_CXX_FLAGS} -Wimplicit-fallthrough")
  endif()

  if(CMAKE_COMPILER_IS_GNUCXX)
    set(C_CXX_FLAGS "${C_CXX_FLAGS} -Wformat-signedness")
  endif()

  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${C_CXX_FLAGS} -Wmissing-prototypes -Wold-style-definition -Wstrict-prototypes")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${C_CXX_FLAGS} -Wmissing-declarations -Wnon-virtual-dtor")

  # In GCC, -Wmissing-declarations is the C++ spelling of -Wmissing-prototypes
  # and using the wrong one is an error. In Clang, -Wmissing-prototypes is the
  # spelling for both and -Wmissing-declarations is some other warning.
  #
  # https://gcc.gnu.org/onlinedocs/gcc-7.1.0/gcc/Warning-Options.html#Warning-Options
  # https://clang.llvm.org/docs/DiagnosticsReference.html#wmissing-prototypes
  # https://clang.llvm.org/docs/DiagnosticsReference.html#wmissing-declarations
  if(CLANG)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wmissing-prototypes")
  endif()
elseif(MSVC)
  set(MSVC_DISABLED_WARNINGS_LIST
      "C4100" # 'exarg' : unreferenced formal parameter
      "C4127" # conditional expression is constant
      "C4244" # 'function' : conversion from 'int' to 'uint8_t',
              # possible loss of data
      "C4267" # conversion from 'size_t' to 'int', possible loss of data
      "C4702" # unreachable code; MSVC's warning is too aggressive. See
              # https://crbug.com/385161043
      "C4706" # assignment within conditional expression
      )
  string(REPLACE "C" " -wd" MSVC_DISABLED_WARNINGS_STR
                            ${MSVC_DISABLED_WARNINGS_LIST})
  set(CMAKE_C_FLAGS   "${CMAKE_C_FLAGS} -utf-8 -W4 -WX ${MSVC_DISABLED_WARNINGS_STR}")
  # Without /Zc:__cplusplus, MSVC does not define the right value for
  # __cplusplus. See https://devblogs.microsoft.com/cppblog/msvc-now-correctly-reports-__cplusplus/
  # If this becomes too problematic for downstream code, we can look at
  # _MSVC_LANG.
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -utf-8 -W4 -WX ${MSVC_DISABLED_WARNINGS_STR} -Zc:__cplusplus")
endif()

if(WIN32)
  add_definitions(-D_HAS_EXCEPTIONS=0)
  add_definitions(-DWIN32_LEAN_AND_MEAN)
  add_definitions(-DNOMINMAX)
  # Allow use of fopen.
  add_definitions(-D_CRT_SECURE_NO_WARNINGS)
endif()

# pthread_rwlock_t on Linux requires a feature flag. We limit this to Linux
# because, on Apple platforms, it instead disables APIs we use. See compat(5)
# and sys/cdefs.h. Reportedly, FreeBSD also breaks when this is set. See
# https://crbug.com/boringssl/471.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -D_XOPEN_SOURCE=700")
endif()

if(FUZZ)
  if(NOT CLANG)
    message(FATAL_ERROR "You need to build with Clang for fuzzing to work")
  endif()

  if(CMAKE_C_COMPILER_VERSION VERSION_LESS "6.0.0")
    message(FATAL_ERROR "You need Clang ≥ 6.0.0")
  endif()

  add_definitions(-DFUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION)
  set(RUNNER_ARGS "-deterministic" "-fuzzer" "-shim-config" "fuzzer_mode.json")

  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=address,fuzzer-no-link -fsanitize-coverage=edge,indirect-calls")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=address,fuzzer-no-link -fsanitize-coverage=edge,indirect-calls")
endif()

add_definitions(-DBORINGSSL_IMPLEMENTATION)

if(BUILD_SHARED_LIBS)
  add_definitions(-DBORINGSSL_SHARED_LIBRARY)
  # Enable position-independent code globally. This is needed because
  # some library targets are OBJECT libraries.
  set(CMAKE_POSITION_INDEPENDENT_CODE TRUE)
endif()

if(MSAN)
  if(NOT CLANG)
    message(FATAL_ERROR "Cannot enable MSAN unless using Clang")
  endif()

  if(ASAN)
    message(FATAL_ERROR "ASAN and MSAN are mutually exclusive")
  endif()

  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=memory -fsanitize-memory-track-origins -fno-omit-frame-pointer")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=memory -fsanitize-memory-track-origins -fno-omit-frame-pointer")
  set(CMAKE_ASM_FLAGS "${CMAKE_ASM_FLAGS} -fsanitize=memory -fsanitize-memory-track-origins -fno-omit-frame-pointer")
endif()

if(ASAN)
  if(NOT CLANG)
    message(FATAL_ERROR "Cannot enable ASAN unless using Clang")
  endif()

  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=address -fsanitize-address-use-after-scope -fno-omit-frame-pointer")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=address -fsanitize-address-use-after-scope -fno-omit-frame-pointer")
endif()

if(CFI)
  if(NOT CLANG)
    message(FATAL_ERROR "Cannot enable CFI unless using Clang")
  endif()

  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=cfi -fno-sanitize-trap=cfi -flto=thin")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=cfi -fno-sanitize-trap=cfi -flto=thin")
  # We use Chromium's copy of clang, which requires -fuse-ld=lld if building
  # with -flto. That, in turn, can't handle -ggdb.
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fuse-ld=lld")
  string(REPLACE "-ggdb" "-g" CMAKE_C_FLAGS "${CMAKE_C_FLAGS}")
  string(REPLACE "-ggdb" "-g" CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS}")
  # -flto causes object files to contain LLVM bitcode. Mixing those with
  # assembly output in the same static library breaks the linker.
  set(OPENSSL_NO_ASM "1")
endif()

if(TSAN)
  if(NOT CLANG)
    message(FATAL_ERROR "Cannot enable TSAN unless using Clang")
  endif()

  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=thread")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=thread")
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fsanitize=thread")
endif()

if(UBSAN)
  if(NOT CLANG)
    message(FATAL_ERROR "Cannot enable UBSAN unless using Clang")
  endif()

  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fsanitize=undefined")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fsanitize=undefined")
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fsanitize=undefined")

  if(NOT UBSAN_RECOVER)
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fno-sanitize-recover=undefined")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fno-sanitize-recover=undefined")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fno-sanitize-recover=undefined")
  endif()
endif()

if(GCOV)
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fprofile-arcs -ftest-coverage")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -fprofile-arcs -ftest-coverage")
endif()

if(FIPS)
  require_go()
  add_definitions(-DBORINGSSL_FIPS)
  if(FIPS_BREAK_TEST)
    add_definitions("-DBORINGSSL_FIPS_BREAK_${FIPS_BREAK_TEST}=1")
  endif()
  # The FIPS integrity check does not work for ASan and MSan builds.
  if(NOT ASAN AND NOT MSAN)
    if(BUILD_SHARED_LIBS)
      set(FIPS_SHARED "1")
    else()
      set(FIPS_DELOCATE "1")
    endif()
  endif()
  if(FIPS_SHARED)
    # The Android CMake files set -ffunction-sections and -fdata-sections,
    # which is incompatible with FIPS_SHARED.
    set(CMAKE_C_FLAGS
        "${CMAKE_C_FLAGS} -fno-function-sections -fno-data-sections")
    set(CMAKE_CXX_FLAGS
        "${CMAKE_CXX_FLAGS} -fno-function-sections -fno-data-sections")
  endif()
endif()

if(OPENSSL_SMALL)
  add_definitions(-DOPENSSL_SMALL)
endif()

if(CONSTANT_TIME_VALIDATION)
  add_definitions(-DBORINGSSL_CONSTANT_TIME_VALIDATION)
endif()

if(MALLOC_FAILURE_TESTING)
  add_definitions(-DBORINGSSL_MALLOC_FAILURE_TESTING)
endif()

if(OPENSSL_NO_ASM)
  add_definitions(-DOPENSSL_NO_ASM)
endif()

if(FIPS_DELOCATE OR NOT OPENSSL_NO_ASM)
  # On x86 and x86_64 Windows, we use the NASM output.
  if(WIN32 AND CMAKE_SYSTEM_PROCESSOR MATCHES "AMD64|x86_64|amd64|x86|i[3-6]86")
    enable_language(ASM_NASM)
    set(OPENSSL_NASM TRUE)
    set(CMAKE_ASM_NASM_FLAGS "${CMAKE_ASM_NASM_FLAGS} -gcv8")
  else()
    enable_language(ASM)
    if (NOT OPENSSL_NO_ASM)
      set(OPENSSL_ASM TRUE)
    endif()
    if(NOT WIN32)
      set(CMAKE_ASM_FLAGS "${CMAKE_ASM_FLAGS} -Wa,--noexecstack")
    endif()
    # Clang's integrated assembler does not support debug symbols.
    if(NOT CMAKE_ASM_COMPILER_ID MATCHES "Clang")
      set(CMAKE_ASM_FLAGS "${CMAKE_ASM_FLAGS} -Wa,-g")
    endif()
  endif()
endif()

if(OPENSSL_NO_SSE2_FOR_TESTING)
  add_definitions(-DOPENSSL_NO_SSE2_FOR_TESTING)
endif()

if(USE_CUSTOM_LIBCXX)
  if(NOT CLANG)
    message(FATAL_ERROR "USE_CUSTOM_LIBCXX only supported with Clang")
  endif()

  # CMake does not allow installing a library without installing dependencies.
  # If we installed libcrypto, we'd have to install our custom libc++, which
  # does not make sense. As this is a test-only configuration, disable
  # installing.
  set(INSTALL_ENABLED 0)

  # CMAKE_CXX_FLAGS ends up in the linker flags as well, so use
  # add_compile_options. There does not appear to be a way to set
  # language-specific compile-only flags.
  add_compile_options("-nostdinc++")
  set(CMAKE_CXX_LINK_FLAGS "${CMAKE_CXX_LINK_FLAGS} -nostdlib++")
  include_directories(
    SYSTEM
    util/bot/libcxx-config
    util/bot/libcxx/include
    util/bot/libcxxabi/include
  )

  # This is patterned after buildtools/third_party/libc++/BUILD.gn and
  # buildtools/third_party/libc++abi/BUILD.gn in Chromium.

  file(GLOB LIBCXX_SOURCES "util/bot/libcxx/src/*.cpp")
  file(GLOB LIBCXXABI_SOURCES "util/bot/libcxxabi/src/*.cpp")

  # This file is meant for exception-less builds.
  list(REMOVE_ITEM LIBCXXABI_SOURCES "trunk/src/cxa_noexception.cpp")
  # libc++ also defines new and delete.
  list(REMOVE_ITEM LIBCXXABI_SOURCES "trunk/src/stdlib_new_delete.cpp")
  if(TSAN)
    # ThreadSanitizer tries to intercept these symbols. Skip them to avoid
    # symbol conflicts.
    list(REMOVE_ITEM LIBCXXABI_SOURCES "trunk/src/cxa_guard.cpp")
  endif()

  add_library(libcxxabi ${LIBCXXABI_SOURCES})
  target_compile_definitions(
    libcxxabi PRIVATE
    -D_LIBCPP_ENABLE_CXX17_REMOVED_UNEXPECTED_FUNCTIONS
  )

  add_library(libcxx ${LIBCXX_SOURCES})
  if(ASAN OR MSAN OR TSAN)
    # Sanitizers try to intercept new and delete.
    target_compile_definitions(
      libcxx PRIVATE
      -D_LIBCPP_DISABLE_NEW_DELETE_DEFINITIONS
    )
  endif()
  target_compile_definitions(
    libcxx PRIVATE
    -D_LIBCPP_BUILDING_LIBRARY
    -DLIBCXX_BUILDING_LIBCXXABI
    -DLIBC_NAMESPACE=bssl_llvm_libc
  )
  # LLVM libc++ depends on some shared headers from LLVM libc.
  target_include_directories(libcxx PRIVATE util/bot/llvm-libc)
  set_target_properties(
    libcxx libcxxabi PROPERTIES
    COMPILE_FLAGS "-Wno-missing-prototypes -Wno-implicit-fallthrough"
    # libc++ and libc++abi must be built in C++23 mode.
    CXX_STANDARD 23
    CXX_STANDARD_REQUIRED TRUE
  )
  # libc++abi depends on libc++ internal headers.
  set_property(TARGET libcxx libcxxabi APPEND PROPERTY INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/util/bot/libcxx/src")
  target_link_libraries(libcxx libcxxabi)
endif()

if(BUILD_TESTING)
  # Add minimal googletest targets. The provided one has many side-effects, and
  # googletest has a very straightforward build.
  add_library(
    boringssl_gtest
    third_party/googletest/googlemock/src/gmock-all.cc
    third_party/googletest/googletest/src/gtest-all.cc
  )
  if(USE_CUSTOM_LIBCXX)
    target_link_libraries(boringssl_gtest libcxx)
  endif()
  target_include_directories(
      boringssl_gtest
      PUBLIC
      third_party/googletest/googlemock/include
      third_party/googletest/googletest/include
      PRIVATE
      third_party/googletest/googlemock
      third_party/googletest/googletest
  )

  # Declare a dummy target to build all unit tests. Test targets should inject
  # themselves as dependencies next to the target definition.
  add_custom_target(boringssl_all_tests)

  add_subdirectory(ssl/test)
endif()

if(OPENSSL_ASM)
  set(CRYPTO_SOURCES_ASM_USED ${CRYPTO_SOURCES_ASM})
  set(BCM_SOURCES_ASM_USED ${BCM_SOURCES_ASM})
  set(TEST_SUPPORT_SOURCES_ASM_USED ${TEST_SUPPORT_SOURCES_ASM})
elseif(OPENSSL_NASM)
  set(CRYPTO_SOURCES_ASM_USED ${CRYPTO_SOURCES_NASM})
  set(BCM_SOURCES_ASM_USED ${BCM_SOURCES_NASM})
  set(TEST_SUPPORT_SOURCES_ASM_USED ${TEST_SUPPORT_SOURCES_NASM})
endif()

if(FIPS_DELOCATE AND FIPS_SHARED)
  message(FATAL_ERROR "Can't set both delocate and shared mode for FIPS build")
endif()

# OSS-Fuzz relies on BORINGSSL_ALLOW_CXX_RUNTIME because -fno-rtti and
# -fsanitize=vptr are incompatible.
set(NO_CXX_RUNTIME_FLAGS)
if(NOT MSVC AND NOT BORINGSSL_ALLOW_CXX_RUNTIME)
  # Without -fno-exceptions, use of std::unique_ptr emits a call to
  # std::terminate.
  set(NO_CXX_RUNTIME_FLAGS -fno-exceptions -fno-rtti)
endif()

if(FIPS_DELOCATE)
  add_library(bcm_c_generated_asm STATIC ${BCM_SOURCES})
  # The C++ code in libcrypto shouldn't depend on libstdc++.
  target_compile_options(bcm_c_generated_asm PRIVATE $<$<COMPILE_LANGUAGE:CXX>:${NO_CXX_RUNTIME_FLAGS}> "-S")
  add_dependencies(bcm_c_generated_asm boringssl_prefix_symbols)
  target_include_directories(bcm_c_generated_asm PRIVATE ${PROJECT_SOURCE_DIR}/include)
  set_target_properties(bcm_c_generated_asm PROPERTIES POSITION_INDEPENDENT_CODE ON)
  if(CLANG)
    # Clang warns when passing both -c (from CMake) and -S.
    target_compile_options(bcm_c_generated_asm PRIVATE "-Wno-unused-command-line-argument")
  endif()
  if(CFI)
    # Delocate needs real assembly code so we need to disable CFI and LTO in the FIPS module.
    target_compile_options(bcm_c_generated_asm PRIVATE "-fno-lto" "-fno-sanitize=cfi")
  endif()

  set(TARGET_FLAG "")
  if(CMAKE_ASM_COMPILER_TARGET)
    set(TARGET_FLAG "--target=${CMAKE_ASM_COMPILER_TARGET}")
  endif()

  go_executable(delocate boringssl.googlesource.com/boringssl.git/util/fipstools/delocate)
  add_custom_command(
    OUTPUT bcm-delocated.S
    COMMAND ${CMAKE_CURRENT_BINARY_DIR}/delocate
            -a $<TARGET_FILE:bcm_c_generated_asm>
            -o ${CMAKE_CURRENT_BINARY_DIR}/bcm-delocated.S
            -cc ${CMAKE_ASM_COMPILER}
            -cc-flags "${TARGET_FLAG} ${CMAKE_ASM_FLAGS}"
            ${BCM_SOURCES_ASM_USED}
            ${CRYPTO_HEADERS}
    DEPENDS bcm_c_generated_asm
            delocate
            ${BCM_SOURCES_ASM_USED}
            ${CRYPTO_HEADERS}
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
  )

  add_library(bcm_hashunset STATIC bcm-delocated.S)
  set_target_properties(bcm_hashunset PROPERTIES POSITION_INDEPENDENT_CODE ON)
  set_target_properties(bcm_hashunset PROPERTIES LINKER_LANGUAGE C)

  go_executable(inject_hash
                boringssl.googlesource.com/boringssl.git/util/fipstools/inject_hash)
  add_custom_command(
    OUTPUT bcm.o
    COMMAND ./inject_hash -o bcm.o -in-archive $<TARGET_FILE:bcm_hashunset>
    DEPENDS bcm_hashunset inject_hash
    WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
  )
  set(CRYPTO_FIPS_OBJECTS bcm.o)
elseif(FIPS_SHARED)
  if(NOT BUILD_SHARED_LIBS)
    message(FATAL_ERROR "FIPS_SHARED set but not BUILD_SHARED_LIBS")
  endif()

  add_library(bcm_library STATIC ${BCM_SOURCES} ${BCM_SOURCES_ASM_USED})
  # The C++ code in libcrypto shouldn't depend on libstdc++.
  target_compile_options(bcm_library PRIVATE $<$<COMPILE_LANGUAGE:CXX>:${NO_CXX_RUNTIME_FLAGS}>)
  add_dependencies(bcm_library boringssl_prefix_symbols)
  target_include_directories(bcm_library PRIVATE ${PROJECT_SOURCE_DIR}/include)

  add_custom_command(
    OUTPUT bcm.o
    COMMAND ${CMAKE_LINKER} -r -T ${CMAKE_CURRENT_SOURCE_DIR}/crypto/fipsmodule/fips_shared.lds -o bcm.o --whole-archive $<TARGET_FILE:bcm_library>
    DEPENDS bcm_library crypto/fipsmodule/fips_shared.lds
    WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
  )
  set(CRYPTO_FIPS_OBJECTS bcm.o)
else()
  add_library(fipsmodule OBJECT ${BCM_SOURCES} ${BCM_SOURCES_ASM_USED})
  # The C++ code in libcrypto shouldn't depend on libstdc++.
  target_compile_options(fipsmodule PRIVATE $<$<COMPILE_LANGUAGE:CXX>:${NO_CXX_RUNTIME_FLAGS}>)
  add_dependencies(fipsmodule boringssl_prefix_symbols)
  target_include_directories(fipsmodule PRIVATE ${PROJECT_SOURCE_DIR}/include)
  set(CRYPTO_FIPS_OBJECTS $<TARGET_OBJECTS:fipsmodule>)
endif()

add_library(crypto ${CRYPTO_SOURCES} ${CRYPTO_FIPS_OBJECTS} ${CRYPTO_SOURCES_ASM_USED})
  # The C++ code in libcrypto shouldn't depend on libstdc++.
target_compile_options(crypto PRIVATE $<$<COMPILE_LANGUAGE:CXX>:${NO_CXX_RUNTIME_FLAGS}>)
target_include_directories(crypto PUBLIC
  $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
set_property(TARGET crypto PROPERTY EXPORT_NAME Crypto)

if(FIPS_SHARED)
  # Rewrite libcrypto.so to inject the correct module hash value. This assumes
  # UNIX-style library naming, but we only support FIPS mode on Linux anyway.
  add_custom_command(
    TARGET crypto POST_BUILD
    COMMAND ${GO_EXECUTABLE} run
    ${CMAKE_CURRENT_SOURCE_DIR}/util/fipstools/inject_hash/inject_hash.go
    -o libcrypto.so -in-object libcrypto.so
    # The DEPENDS argument to a POST_BUILD rule appears to be ignored. Thus
    # go_executable isn't used (as it doesn't get built), but we list this
    # dependency anyway in case it starts working in some CMake version.
    DEPENDS util/fipstools/inject_hash/inject_hash.go
    WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
  )
endif()

add_dependencies(crypto boringssl_prefix_symbols)
if(WIN32)
  target_link_libraries(crypto ws2_32)
endif()

# CMAKE_SYSTEM_NAME is "Generic" for embedded OSes:
# https://cmake.org/cmake/help/book/mastering-cmake/chapter/Cross%20Compiling%20With%20CMake.html#toolchain-files
#
# For now we assume embedded OSes do not have threads. Additionally, the Threads
# package does not work with Android, but Android does not require any extra
# parameters to link pthreads.
if(NOT CMAKE_SYSTEM_NAME MATCHES "^(Generic|Android)$")
  find_package(Threads REQUIRED)
  target_link_libraries(crypto Threads::Threads)
endif()

# Every target depends on crypto, so we add libcxx as a dependency here to
# simplify injecting it everywhere.
if(USE_CUSTOM_LIBCXX)
  target_link_libraries(crypto libcxx)
endif()

add_library(ssl ${SSL_SOURCES})
# Although libssl also provides headers that require an include directory, the
# flag is already specified by libcrypto, so we omit target_include_directories
# here.
set_property(TARGET ssl PROPERTY EXPORT_NAME SSL)
target_link_libraries(ssl crypto)

add_library(decrepit ${DECREPIT_SOURCES})
target_link_libraries(decrepit ssl crypto)

if(APPLE)
  set(PKI_CXX_FLAGS "-fno-aligned-new")
endif()
add_library(pki ${PKI_SOURCES})
target_link_libraries(pki crypto)
target_compile_options(pki PRIVATE ${PKI_CXX_FLAGS})

if(BUILD_TESTING)
  add_library(test_support_lib STATIC
              ${TEST_SUPPORT_SOURCES} ${TEST_SUPPORT_SOURCES_ASM_USED})
  if(LIBUNWIND_FOUND)
    target_compile_options(test_support_lib PRIVATE ${LIBUNWIND_CFLAGS_OTHER})
    target_include_directories(test_support_lib PRIVATE ${LIBUNWIND_INCLUDE_DIRS})
    target_link_libraries(test_support_lib ${LIBUNWIND_LDFLAGS})
  endif()
  if(WIN32)
    target_link_libraries(test_support_lib dbghelp)
  endif()
  target_link_libraries(test_support_lib boringssl_gtest crypto)

  # urandom_test is a separate binary because it needs to be able to observe the
  # PRNG initialisation, which means that it can't have other tests running before
  # it does.
  add_executable(urandom_test ${URANDOM_TEST_SOURCES})
  target_link_libraries(urandom_test test_support_lib boringssl_gtest crypto)
  add_dependencies(boringssl_all_tests urandom_test)

  add_executable(crypto_test ${CRYPTO_TEST_SOURCES})
  target_link_libraries(crypto_test test_support_lib boringssl_gtest crypto)
  add_dependencies(boringssl_all_tests crypto_test)

  add_executable(ssl_test ${SSL_TEST_SOURCES})
  target_link_libraries(ssl_test test_support_lib boringssl_gtest ssl crypto)
  add_dependencies(boringssl_all_tests ssl_test)
  add_executable(decrepit_test ${DECREPIT_TEST_SOURCES})
  target_link_libraries(decrepit_test test_support_lib boringssl_gtest
                        decrepit ssl crypto)
  add_dependencies(boringssl_all_tests decrepit_test)

  add_executable(pki_test ${PKI_TEST_SOURCES})
  target_link_libraries(pki_test test_support_lib boringssl_gtest pki crypto)
  target_compile_options(pki_test PRIVATE ${PKI_CXX_FLAGS})
  add_dependencies(boringssl_all_tests pki_test)

  add_executable(test_fips util/fipstools/test_fips.cc)
  target_link_libraries(test_fips crypto)

  add_executable(jitter_deltas util/fipstools/entropy/jitter_deltas.cc)
  target_link_libraries(jitter_deltas crypto)
endif()

if(FIPS)
  add_executable(modulewrapper ${MODULEWRAPPER_SOURCES})
  target_link_libraries(modulewrapper crypto)
  add_executable(entropy_modulewrapper ${ENTROPY_MODULEWRAPPER_SOURCES})
  target_link_libraries(entropy_modulewrapper crypto)
endif()

add_executable(bssl ${BSSL_SOURCES})
target_link_libraries(bssl ssl crypto)

if(FUZZ)
  if(LIBFUZZER_FROM_DEPS)
    file(GLOB LIBFUZZER_SOURCES "util/bot/libFuzzer/*.cpp")
    add_library(Fuzzer STATIC ${LIBFUZZER_SOURCES})
    # libFuzzer does not pass our aggressive warnings. It also must be built
    # without -fsanitize-coverage options or clang crashes.
    set_target_properties(
      Fuzzer PROPERTIES
      COMPILE_FLAGS "-Wno-shadow -Wno-format-nonliteral -Wno-missing-prototypes -fsanitize-coverage=0"
    )
  endif()

  add_subdirectory(fuzz)
endif()

if(RUST_BINDINGS)
  find_program(BINDGEN_EXECUTABLE bindgen REQUIRED)
  add_subdirectory(rust)
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  set(HANDSHAKER_ARGS "-handshaker-path" $<TARGET_FILE:handshaker>)
endif()

if(BUILD_TESTING)
  if(FIPS)
    add_custom_target(
      acvp_tests
      COMMAND ${GO_EXECUTABLE} build -o ${CMAKE_CURRENT_BINARY_DIR}/acvptool
              boringssl.googlesource.com/boringssl.git/util/fipstools/acvp/acvptool
      COMMAND ${GO_EXECUTABLE} build -o ${CMAKE_CURRENT_BINARY_DIR}/testmodulewrapper
              boringssl.googlesource.com/boringssl.git/util/fipstools/acvp/acvptool/testmodulewrapper
      COMMAND cd util/fipstools/acvp/acvptool/test &&
              ${GO_EXECUTABLE} run check_expected.go
              -tool ${CMAKE_CURRENT_BINARY_DIR}/acvptool
              -module-wrappers modulewrapper:$<TARGET_FILE:modulewrapper>,testmodulewrapper:${CMAKE_CURRENT_BINARY_DIR}/testmodulewrapper
              -tests tests.json
      WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
      DEPENDS modulewrapper
      USES_TERMINAL)

    add_custom_target(
      fips_specific_tests_if_any
      DEPENDS acvp_tests
    )
  else()
    add_custom_target(fips_specific_tests_if_any)
  endif()

  file(STRINGS util/go_tests.txt GO_TESTS)
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
              util/go_tests.txt)

  # CMake target names can clash when projects are imported with
  # add_subdirectory. Only emit the run_tests target if we're the top-level
  # target. See https://crbug.com/428112180.
  if(PROJECT_IS_TOP_LEVEL)
    if(GO_EXECUTABLE)
      add_custom_target(
          run_tests
          COMMAND ${CMAKE_COMMAND} -E echo "Running Go tests"
          COMMAND ${GO_EXECUTABLE} test ${GO_TESTS}
          COMMAND ${CMAKE_COMMAND} -E echo
          COMMAND ${CMAKE_COMMAND} -E echo "Running unit tests"
          COMMAND ${GO_EXECUTABLE} run util/all_tests.go -build-dir
                  ${CMAKE_CURRENT_BINARY_DIR}
          COMMAND ${CMAKE_COMMAND} -E echo
          COMMAND ${CMAKE_COMMAND} -E echo "Running SSL tests"
          COMMAND cd ssl/test/runner &&
                  ${GO_EXECUTABLE} test -shim-path $<TARGET_FILE:bssl_shim>
                    ${HANDSHAKER_ARGS} ${RUNNER_ARGS}
          WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
          DEPENDS boringssl_all_tests bssl_shim handshaker fips_specific_tests_if_any
          USES_TERMINAL)
    else()
      add_custom_target(
          run_tests
          COMMAND ${CMAKE_COMMAND} -E echo "Running tests requires Go"
          COMMAND ${CMAKE_COMMAND} -E false)
    endif()
  endif()
endif()

if(INSTALL_ENABLED)
  install(TARGETS crypto ssl EXPORT OpenSSLTargets)
  install(TARGETS bssl)
  install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
  install(EXPORT OpenSSLTargets
          FILE OpenSSLTargets.cmake
          NAMESPACE OpenSSL::
          DESTINATION lib/cmake/OpenSSL)
  install(FILES cmake/OpenSSLConfig.cmake DESTINATION lib/cmake/OpenSSL)
endif()
