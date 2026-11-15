// Copyright 2024 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "test_data.h"

#include <stdio.h>
#include <stdlib.h>

#include "file_util.h"

#if defined(BORINGSSL_USE_BAZEL_RUNFILES)
#include "tools/cpp/runfiles/runfiles.h"

using bazel::tools::cpp::runfiles::Runfiles;
#endif

#if !defined(BORINGSSL_CUSTOM_GET_TEST_DATA)
std::string GetTestData(const char *path) {
#if defined(BORINGSSL_USE_BAZEL_RUNFILES)
  std::string error;
  std::unique_ptr<Runfiles> runfiles(
      Runfiles::CreateForTest(BAZEL_CURRENT_REPOSITORY, &error));
  if (runfiles == nullptr) {
    fprintf(stderr, "Could not initialize runfiles: %s\n", error.c_str());
    abort();
  }

  std::string full_path = runfiles->Rlocation(std::string("boringssl/") + path);
  if (full_path.empty()) {
    fprintf(stderr, "Could not find runfile '%s'.\n", path);
    abort();
  }
#else
  const char *root = getenv("BORINGSSL_TEST_DATA_ROOT");
  root = root != nullptr ? root : ".";

  std::string full_path = root;
  full_path.push_back('/');
  full_path.append(path);
#endif

  bssl::ScopedFILE file(fopen(full_path.c_str(), "rb"));
  if (file == nullptr) {
    fprintf(stderr, "Could not open '%s'.\n", full_path.c_str());
    abort();
  }

  std::string ret;
  for (;;) {
    char buf[512];
    size_t n = fread(buf, 1, sizeof(buf), file.get());
    if (n == 0) {
      if (feof(file.get())) {
        return ret;
      }
      fprintf(stderr, "Error reading from '%s'.\n", full_path.c_str());
      abort();
    }
    ret.append(buf, n);
  }
}
#endif  // !BORINGSSL_CUSTOM_GET_TEST_DATA
