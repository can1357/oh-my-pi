// Copyright 2025 The BoringSSL Authors
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

// BoringCrypto Jitter Entropy version 20250725.

#include <openssl/base.h>

#if defined(OPENSSL_LINUX) || defined(OPENSSL_MACOS)

#include <vector>

#include <errno.h>
#include <stdio.h>
#include <unistd.h>

#include "../../../crypto/fipsmodule/entropy/internal.h"

using namespace bssl;

static bool parse_size_t(const char *str, size_t *out) {
  if (*str == '\0') {
    return false;
  }

  char *endptr;
  errno = 0;
  unsigned long long val = strtoull(str, &endptr, 10);
  if (errno == ERANGE || *endptr != '\0' || val > SIZE_MAX) {
    return false;
  }
  *out = static_cast<size_t>(val);
  return true;
}

static int usage(const char *binname) {
  fprintf(stderr, "Usage: %s [number of samples] > samples\n", binname);
  return 1;
}

int main(int argc, char **argv) {
  size_t num_samples;
  if (argc > 2 || isatty(STDOUT_FILENO)) {
    return usage(argv[0]);
  } else if (argc == 2) {
    if (!parse_size_t(argv[1], &num_samples) || num_samples == 0) {
      return usage(argv[0]);
    }
  } else {
    num_samples = 1024;
  }

  std::vector<uint64_t> samples(num_samples);
  if (!entropy::GetSamples(samples.data(), samples.size())) {
    fprintf(stderr, "Sampling failed\n");
    return 2;
  }
  const size_t num_out_bytes = num_samples * sizeof(samples[0]);
  const ssize_t written = write(STDOUT_FILENO, samples.data(), num_out_bytes);
  if (written < 0 || static_cast<size_t>(written) != num_out_bytes) {
    fprintf(stderr, "Failed to write output\n");
    return 3;
  }
  return 0;
}

#else

#include <stdio.h>

int main(int argc, char **argv) {
  fprintf(stderr, "No jitter entropy support in this build.\n");
  return 1;
}

#endif
