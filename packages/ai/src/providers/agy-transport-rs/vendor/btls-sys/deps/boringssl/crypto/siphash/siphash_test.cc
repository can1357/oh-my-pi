// Copyright 2019 The BoringSSL Authors
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

#include <stdint.h>

#include <gtest/gtest.h>

#include <openssl/siphash.h>

#include "../test/file_test.h"
#include "../test/test_util.h"

TEST(SipHash, Basic) {
  // This is the example from appendix A of the SipHash paper.
  uint8_t key_bytes[16];
  for (unsigned i = 0; i < 16; i++) {
    key_bytes[i] = i;
  }
  uint64_t key[2];
  memcpy(key, key_bytes, sizeof(key));

  uint8_t input[15];
  for (unsigned i = 0; i < sizeof(input); i++) {
    input[i] = i;
  }

  EXPECT_EQ(UINT64_C(0xa129ca6149be45e5),
            SIPHASH_24(key, input, sizeof(input)));
}

TEST(SipHash, Vectors) {
  FileTestGTest("crypto/siphash/siphash_tests.txt", [](FileTest *t) {
    std::vector<uint8_t> key, msg, hash;
    ASSERT_TRUE(t->GetBytes(&key, "KEY"));
    ASSERT_TRUE(t->GetBytes(&msg, "IN"));
    ASSERT_TRUE(t->GetBytes(&hash, "HASH"));
    ASSERT_EQ(16u, key.size());
    ASSERT_EQ(8u, hash.size());

    uint64_t key_words[2];
    memcpy(key_words, key.data(), key.size());
    uint64_t result = SIPHASH_24(key_words, msg.data(), msg.size());
    EXPECT_EQ(Bytes(reinterpret_cast<uint8_t *>(&result), sizeof(result)),
              Bytes(hash));
  });
}
