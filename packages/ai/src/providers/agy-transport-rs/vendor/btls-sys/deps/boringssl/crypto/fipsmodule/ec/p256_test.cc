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

#include <gtest/gtest.h>
#include "../../internal.h"
#include "../../test/abi_test.h"

#if !defined(OPENSSL_NO_ASM) && defined(__GNUC__) && defined(__x86_64__) && \
    defined(SUPPORTS_ABI_TEST)
extern "C" {
#include "../../../third_party/fiat/p256_field.c.inc"
}

TEST(P256Test, AdxMulABI) {
  static const uint64_t in1[4] = {0}, in2[4] = {0};
  uint64_t out[4];
  if (CRYPTO_is_BMI1_capable() && CRYPTO_is_BMI2_capable() &&
      CRYPTO_is_ADX_capable()) {
    CHECK_ABI(fiat_p256_adx_mul, out, in1, in2);
  } else {
    GTEST_SKIP() << "Can't test ABI of ADX code without ADX";
  }
}

#include <assert.h>
TEST(P256Test, AdxSquareABI) {
  static const uint64_t in[4] = {0};
  uint64_t out[4];
  if (CRYPTO_is_BMI1_capable() && CRYPTO_is_BMI2_capable() &&
      CRYPTO_is_ADX_capable()) {
    CHECK_ABI(fiat_p256_adx_sqr, out, in);
  } else {
    GTEST_SKIP() << "Can't test ABI of ADX code without ADX";
  }
}
#endif
