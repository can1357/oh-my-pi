// Copyright 2014-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include "internal.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

#include <limits>

#include <gtest/gtest.h>
#include "test/test_util.h"

#include <openssl/mem.h>
#include <openssl/rand.h>


static uint8_t FromBool8(bool b) {
  return b ? CONSTTIME_TRUE_8 : CONSTTIME_FALSE_8;
}

static crypto_word_t FromBoolW(bool b) {
  return b ? CONSTTIME_TRUE_W : CONSTTIME_FALSE_W;
}

static const uint8_t test_values_8[] = {0, 1, 2, 20, 32, 127, 128, 129, 255};

static crypto_word_t test_values_w[] = {
    0,
    1,
    1024,
    12345,
    32000,
#if defined(OPENSSL_64_BIT)
    0xffffffff / 2 - 1,
    0xffffffff / 2,
    0xffffffff / 2 + 1,
    0xffffffff - 1,
    0xffffffff,
#endif
    std::numeric_limits<crypto_word_t>::max() / 2 - 1,
    std::numeric_limits<crypto_word_t>::max() / 2,
    std::numeric_limits<crypto_word_t>::max() / 2 + 1,
    std::numeric_limits<crypto_word_t>::max() - 1,
    std::numeric_limits<crypto_word_t>::max(),
};

static int signed_test_values[] = {
    0,     1,      -1,      1024,    -1024,       12345,      -12345,
    32000, -32000, INT_MAX, INT_MIN, INT_MAX - 1, INT_MIN + 1};

TEST(ConstantTimeTest, Test) {
  for (crypto_word_t a : test_values_w) {
    SCOPED_TRACE(a);

    EXPECT_EQ(FromBoolW(a == 0), constant_time_is_zero_w(a));
    EXPECT_EQ(FromBool8(a == 0), constant_time_is_zero_8(a));

    for (crypto_word_t b : test_values_w) {
      SCOPED_TRACE(b);

      EXPECT_EQ(FromBoolW(a < b), constant_time_lt_w(a, b));
      EXPECT_EQ(FromBool8(a < b), constant_time_lt_8(a, b));

      EXPECT_EQ(FromBoolW(a >= b), constant_time_ge_w(a, b));
      EXPECT_EQ(FromBool8(a >= b), constant_time_ge_8(a, b));

      EXPECT_EQ(FromBoolW(a == b), constant_time_eq_w(a, b));
      EXPECT_EQ(FromBool8(a == b), constant_time_eq_8(a, b));

      EXPECT_EQ(a, constant_time_select_w(CONSTTIME_TRUE_W, a, b));
      EXPECT_EQ(b, constant_time_select_w(CONSTTIME_FALSE_W, a, b));
    }
  }

  for (int a : signed_test_values) {
    SCOPED_TRACE(a);
    for (int b : signed_test_values) {
      SCOPED_TRACE(b);

      EXPECT_EQ(a, constant_time_select_int(CONSTTIME_TRUE_W, a, b));
      EXPECT_EQ(b, constant_time_select_int(CONSTTIME_FALSE_W, a, b));

      EXPECT_EQ(FromBoolW(a == b), constant_time_eq_int(a, b));
      EXPECT_EQ(FromBool8(a == b), constant_time_eq_int_8(a, b));
    }
  }

  for (uint8_t a : test_values_8) {
    SCOPED_TRACE(static_cast<int>(a));
    for (uint8_t b : test_values_8) {
      SCOPED_TRACE(static_cast<int>(b));
      EXPECT_EQ(a, constant_time_select_8(CONSTTIME_TRUE_8, a, b));
      EXPECT_EQ(b, constant_time_select_8(CONSTTIME_FALSE_8, a, b));
    }
  }
}

TEST(ConstantTimeTest, MemCmp) {
  uint8_t buf[256], copy[256];
  RAND_bytes(buf, sizeof(buf));

  OPENSSL_memcpy(copy, buf, sizeof(buf));
  EXPECT_EQ(0, CRYPTO_memcmp(buf, copy, sizeof(buf)));

  for (size_t i = 0; i < sizeof(buf); i++) {
    for (uint8_t bit = 1; bit != 0; bit <<= 1) {
      OPENSSL_memcpy(copy, buf, sizeof(buf));
      copy[i] ^= bit;
      EXPECT_NE(0, CRYPTO_memcmp(buf, copy, sizeof(buf)));
    }
  }
}

TEST(ConstantTimeTest, ValueBarrier) {
  for (int i = 0; i < 10; i++) {
    crypto_word_t word;
    RAND_bytes(reinterpret_cast<uint8_t *>(&word), sizeof(word));
    EXPECT_EQ(word, value_barrier_w(word));

    uint32_t u32;
    RAND_bytes(reinterpret_cast<uint8_t *>(&u32), sizeof(u32));
    EXPECT_EQ(u32, value_barrier_u32(u32));

    uint64_t u64;
    RAND_bytes(reinterpret_cast<uint8_t *>(&u64), sizeof(u64));
    EXPECT_EQ(u64, value_barrier_u64(u64));
  }
}

TEST(ConstantTimeTest, MemCmov) {
  static constexpr size_t kMaxLen = 256;
  uint8_t out[kMaxLen], in[kMaxLen];
  for (size_t len = 0; len <= kMaxLen; len++) {
    SCOPED_TRACE(len);
    for (int i = 0; i < 100; i++) {
      RAND_bytes(out, len);
      RAND_bytes(in, len);

      uint8_t b = 0;
      RAND_bytes(&b, 1);
      b = constant_time_is_zero_8(b & 0xf);

      uint8_t ref_in[256];
      OPENSSL_memcpy(ref_in, in, len);

      uint8_t ref_out[256];
      OPENSSL_memcpy(ref_out, out, len);
      if (b) {
        OPENSSL_memcpy(ref_out, in, len);
      }

      CONSTTIME_SECRET(out, len);
      CONSTTIME_SECRET(in, len);
      CONSTTIME_SECRET(&b, 1);

      constant_time_conditional_memcpy(out, in, len, b);

      CONSTTIME_DECLASSIFY(&in, len);
      CONSTTIME_DECLASSIFY(&out, len);

      EXPECT_EQ(Bytes(in, len), Bytes(ref_in, len));
      EXPECT_EQ(Bytes(out, len), Bytes(ref_out, len));
    }
  }
}

TEST(ConstantTimeTest, MemCxor) {
  static constexpr size_t kMaxLen = 256;
  uint8_t out[kMaxLen], in[kMaxLen];
  for (size_t len = 0; len <= kMaxLen; len++) {
    SCOPED_TRACE(len);
    for (int i = 0; i < 100; i++) {
      RAND_bytes(out, len);
      RAND_bytes(in, len);

      uint8_t b = 0;
      RAND_bytes(&b, 1);
      b = constant_time_is_zero_8(b & 0xf);

      uint8_t ref_in[kMaxLen];
      OPENSSL_memcpy(ref_in, in, len);

      uint8_t ref_out[kMaxLen];
      OPENSSL_memcpy(ref_out, out, len);
      if (b) {
        for (size_t j = 0; j < len; ++j) {
          ref_out[j] ^= in[j];
        }
      }

      CONSTTIME_SECRET(out, len);
      CONSTTIME_SECRET(in, len);
      CONSTTIME_SECRET(&b, 1);

      constant_time_conditional_memxor(out, in, len, b);

      CONSTTIME_DECLASSIFY(&in, len);
      CONSTTIME_DECLASSIFY(&out, len);

      EXPECT_EQ(Bytes(in, len), Bytes(ref_in, len));
      EXPECT_EQ(Bytes(out, len), Bytes(ref_out, len));
    }
  }
}
