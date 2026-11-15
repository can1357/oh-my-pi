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

#include <gtest/gtest.h>
#include <openssl/rand.h>

#include "bedrock_unverified_platform.c.inc"
namespace ref {
#include "bedrock_unverified_bareminimum.c.inc" // currently unused but planned
#include "bedrock_polyfill_platform.c.inc"
}

namespace {

#define SECRET_EQ_W(a, b) EXPECT_EQ(br_declassify(a), br_declassify(b))

TEST(BedrockTest, ArithmeticAndBroadcast) {
  std::vector<br_word_t> test_values = {
      0,
      1,
      1024,
      12345,
      32000,
      0xffffffff / 2 - 1,
      0xffffffff / 2,
      0xffffffff / 2 + 1,
      0xffffffff - 1,
      0xffffffff,
      std::numeric_limits<br_word_t>::max() / 2 - 1,
      std::numeric_limits<br_word_t>::max() / 2,
      std::numeric_limits<br_word_t>::max() / 2 + 1,
      std::numeric_limits<br_word_t>::max() - 1,
      std::numeric_limits<br_word_t>::max(),
  };

  for (int i = 0; i < 100; i++) {
    br_word_t word;
    RAND_bytes(reinterpret_cast<uint8_t *>(&word), sizeof(word));
    test_values.push_back(word);
  }

  auto broadcast = [](bool b) { return b ? 0u-(br_word_t)1 : (br_word_t)0; };

  for (br_word_t a : test_values) {
    SCOPED_TRACE(a);

    EXPECT_EQ(a, br_value_barrier(a));
    EXPECT_EQ(a, ref::br_value_barrier(a));
    EXPECT_EQ(a, br_declassify(a));
    EXPECT_EQ(a, ref::br_declassify(a));
    EXPECT_EQ(broadcast(a != 0), br_broadcast_nonzero(a));
    EXPECT_EQ(broadcast(a != 0), ref::br_broadcast_nonzero(a));
    EXPECT_EQ(broadcast((br_signed_t)a < 0), br_broadcast_negative(a));
    EXPECT_EQ(broadcast((br_signed_t)a < 0), ref::br_broadcast_negative(a));

    CONSTTIME_SECRET(&a, sizeof(a));

    br_word_t t = broadcast(true);
    SECRET_EQ_W(br_broadcast_negative(a) | br_broadcast_negative(~a), t);
    SECRET_EQ_W(br_broadcast_nonzero(a) | br_broadcast_nonzero(~a), t);

    for (br_word_t b : test_values) {
      SCOPED_TRACE(b);
      CONSTTIME_SECRET(&b, sizeof(b));

      SECRET_EQ_W(a, br_cmov(broadcast(true), a, b));
      SECRET_EQ_W(b, br_cmov(broadcast(false), a, b));

      br_word_t lo = 0, lr = 0;
      SECRET_EQ_W(br_full_mul(a, b, &lo), ref::br_full_mul(a, b, &lr));
      SECRET_EQ_W(lo, lr);
      SECRET_EQ_W(lo, a * b);

      for (br_word_t c : {0, 1}) {
        SCOPED_TRACE(c);
        CONSTTIME_SECRET(&c, sizeof(c));

        SECRET_EQ_W(br_declassify(a) ? b : c, br_cmov(a, b, c));
        SECRET_EQ_W(br_declassify(a) ? c : b, br_cmov(a, c, b));

        SECRET_EQ_W(br_full_add(a, b, c, &lo), ref::br_full_add(a, b, c, &lr));
        SECRET_EQ_W(lo, lr);
        SECRET_EQ_W(lo, a + b + c);

        SECRET_EQ_W(br_full_sub(a, b, c, &lo), ref::br_full_sub(a, b, c, &lr));
        SECRET_EQ_W(lo, lr);
        SECRET_EQ_W(lo, a - b - c);
      }
    }
  }
}

#undef SECRET_EQ_W
} // namespace
