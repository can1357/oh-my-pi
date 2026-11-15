// Copyright 2016 The BoringSSL Authors
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

#include <stdio.h>
#include <string.h>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <openssl/rand.h>

#include "abi_test.h"
#include "gtest_main.h"
#include "../internal.h"


int main(int argc, char **argv) {
  testing::InitGoogleMock(&argc, argv);
  bssl::SetupGoogleTest();

  bool unwind_tests = true;
  for (int i = 1; i < argc; i++) {
#if !defined(OPENSSL_WINDOWS)
    if (strcmp(argv[i], "--fork_unsafe_buffering") == 0) {
      RAND_enable_fork_unsafe_buffering(-1);
    }
#endif

#if (defined(OPENSSL_ARM) || defined(OPENSSL_AARCH64)) && \
    !defined(OPENSSL_STATIC_ARMCAP)
    if (strncmp(argv[i], "--cpu=", 6) == 0) {
      const char *cpu = argv[i] + 6;
      uint32_t armcap;
      if (strcmp(cpu, "none") == 0) {
        armcap = 0;
      } else if (strcmp(cpu, "neon") == 0) {
        armcap = ARMV7_NEON;
      } else if (strcmp(cpu, "crypto") == 0) {
        armcap = ARMV7_NEON | ARMV8_AES | ARMV8_SHA1 | ARMV8_SHA256 | ARMV8_PMULL;
      } else {
        fprintf(stderr, "Unknown CPU: %s\n", cpu);
        exit(1);
      }

      uint32_t *armcap_ptr = OPENSSL_get_armcap_pointer_for_test();
      if ((armcap & *armcap_ptr) != armcap) {
        fprintf(stderr,
                "Host CPU does not support features for testing CPU '%s'.\n",
                cpu);
        exit(89);
      }
      printf("Simulating CPU '%s'\n", cpu);
      *armcap_ptr = armcap;
    }
#endif  // (ARM || AARCH64) && !STATIC_ARMCAP

    if (strcmp(argv[i], "--no_unwind_tests") == 0) {
      unwind_tests = false;
    }
  }

  if (unwind_tests) {
    abi_test::EnableUnwindTests();
  }

  return RUN_ALL_TESTS();
}
