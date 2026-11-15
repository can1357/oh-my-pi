# Copyright 2023 The BoringSSL Authors
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

# Go is an optional dependency. It's a necessary dependency if running tests or
# the FIPS build, which will check these.
find_program(GO_EXECUTABLE go)

function(require_go)
  if(NOT GO_EXECUTABLE)
    message(FATAL_ERROR "Could not find Go")
  endif()
endfunction()

function(go_executable dest package)
  require_go()
  set(godeps "${PROJECT_SOURCE_DIR}/util/godeps.go")
  # Ninja expects the target in the depfile to match the output. This is a
  # relative path from the build directory.
  set(target "${CMAKE_CURRENT_BINARY_DIR}/${dest}")
  cmake_path(RELATIVE_PATH target BASE_DIRECTORY "${CMAKE_BINARY_DIR}")

  set(depfile "${CMAKE_CURRENT_BINARY_DIR}/${dest}.d")
  add_custom_command(OUTPUT ${dest}
                      COMMAND ${GO_EXECUTABLE} build
                              -o ${CMAKE_CURRENT_BINARY_DIR}/${dest} ${package}
                      COMMAND ${GO_EXECUTABLE} run ${godeps} -format depfile
                              -target ${target} -pkg ${package} -out ${depfile}
                      WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
                      DEPENDS ${godeps} ${PROJECT_SOURCE_DIR}/go.mod
                      DEPFILE ${depfile})
endfunction()

