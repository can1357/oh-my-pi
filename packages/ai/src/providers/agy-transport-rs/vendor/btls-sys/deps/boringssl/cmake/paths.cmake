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

# copy_post_build causes targets in ${ARGN} to be copied to
# ${CMAKE_CURRENT_BINARY_DIR}/${dir} after being built.
function(copy_post_build dir)
  foreach(target ${ARGN})
    add_custom_command(
      TARGET ${target}
      POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/${dir}"
      COMMAND ${CMAKE_COMMAND} -E copy $<TARGET_FILE:${target}> "${CMAKE_CURRENT_BINARY_DIR}/${dir}")
  endforeach()
endfunction()
