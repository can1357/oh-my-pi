# Preserve the caller's compiler/CRT/SDK when cross-compiling. On native
# Windows, CMake discovers these from the target Visual Studio environment.
if(DEFINED ENV{OMP_NATIVE_CMAKE_TOOLCHAIN} AND NOT "$ENV{OMP_NATIVE_CMAKE_TOOLCHAIN}" STREQUAL "")
  include("$ENV{OMP_NATIVE_CMAKE_TOOLCHAIN}")
endif()

# ARM64 Windows always has NEON. Opus' optional ARM32 runtime probe uses
# __emit and cannot compile for ARM64. Its headers still need the intrinsics
# declarations (the upstream CMake build couples them to the optional probe).
set(OPUS_PRESUME_NEON ON CACHE BOOL "ARM64 always has NEON" FORCE)
set(OPUS_MAY_HAVE_NEON OFF CACHE BOOL "Do not build the ARM32 runtime probe" FORCE)
set(OPUS_STATIC_RUNTIME ON CACHE BOOL "Match the linked runtime's static CRT" FORCE)
add_compile_definitions(OPUS_ARM_MAY_HAVE_NEON_INTR)
