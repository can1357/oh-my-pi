// Copyright 2023 The BoringSSL Authors
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

#if !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE  // Needed for getentropy on musl and glibc
#endif

#include <openssl/rand.h>

#include "../fipsmodule/rand/internal.h"

#if defined(OPENSSL_RAND_GETENTROPY)

#include <unistd.h>

#include <errno.h>

#if defined(OPENSSL_MACOS) || defined(OPENSSL_FUCHSIA)
#include <sys/random.h>
#endif

#include <gtest/gtest.h>

#include <openssl/span.h>

#include "../test/test_util.h"

// This test is, strictly speaking, flaky, but we use large enough buffers
// that the probability of failing when we should pass is negligible.

TEST(GetEntropyTest, NotObviouslyBroken) {
  static const uint8_t kZeros[256] = {0};

  uint8_t buf1[256], buf2[256];

  EXPECT_EQ(getentropy(buf1, sizeof(buf1)), 0);
  EXPECT_EQ(getentropy(buf2, sizeof(buf2)), 0);
  EXPECT_NE(Bytes(buf1), Bytes(buf2));
  EXPECT_NE(Bytes(buf1), Bytes(kZeros));
  EXPECT_NE(Bytes(buf2), Bytes(kZeros));
  uint8_t buf3[256];
  // Ensure that the implementation is not simply returning the memory unchanged.
  memcpy(buf3, buf1, sizeof(buf3));
  EXPECT_EQ(getentropy(buf1, sizeof(buf1)), 0);
  EXPECT_NE(Bytes(buf1), Bytes(buf3));
  errno = 0;
  uint8_t toobig[257];
  // getentropy should fail returning -1 and setting errno to EIO if you request
  // more than 256 bytes of entropy. macOS's man page says EIO but it actually
  // returns EINVAL, so we accept either.
  EXPECT_EQ(getentropy(toobig, 257), -1);
  EXPECT_TRUE(errno == EIO || errno == EINVAL);
}
#endif
