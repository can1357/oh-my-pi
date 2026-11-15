// Copyright 2018 The BoringSSL Authors
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

#include <openssl/sha.h>

#include <vector>

#include <gtest/gtest.h>

#include "internal.h"
#include "../../test/abi_test.h"
#include "../../test/test_util.h"


TEST(SHATest, FIPS1862PRF) {
  // From "Multiple Examples of DSA", section 2.2, fetched from archived copy at
  // https://web.archive.org/web/20041031124637/http://csrc.nist.gov/CryptoToolkit/dss/Examples-1024bit.pdf
  const uint8_t kSeed[] = {0xbd, 0x02, 0x9b, 0xbe, 0x7f, 0x51, 0x96,
                           0x0b, 0xcf, 0x9e, 0xdb, 0x2b, 0x61, 0xf0,
                           0x6f, 0x0f, 0xeb, 0x5a, 0x38, 0xb6};
  const uint8_t kExpected[] = {0x20, 0x70, 0xb3, 0x22, 0x3d, 0xba, 0x37, 0x2f,
                               0xde, 0x1c, 0x0f, 0xfc, 0x7b, 0x2e, 0x3b, 0x49,
                               0x8b, 0x26, 0x06, 0x14, 0x3c, 0x6c, 0x18, 0xba,
                               0xcb, 0x0f, 0x6c, 0x55, 0xba, 0xbb, 0x13, 0x78,
                               0x8e, 0x20, 0xd7, 0x37, 0xa3, 0x27, 0x51, 0x16};
  for (size_t len = 0; len <= sizeof(kExpected); len++) {
    SCOPED_TRACE(len);
    std::vector<uint8_t> out(len);
    CRYPTO_fips_186_2_prf(out.data(), out.size(), kSeed);
    EXPECT_EQ(Bytes(out), Bytes(kExpected, len));
  }
}

#if defined(SUPPORTS_ABI_TEST)

TEST(SHATest, SHA1ABI) {
  SHA_CTX ctx;
  SHA1_Init(&ctx);

  static const uint8_t kBuf[SHA_CBLOCK * 8] = {0};
  for (size_t blocks : {1, 2, 4, 8}) {
#if defined(SHA1_ASM)
    CHECK_ABI(sha1_block_data_order, ctx.h, kBuf, blocks);
#endif
#if defined(SHA1_ASM_HW)
    if (sha1_hw_capable()) {
      CHECK_ABI(sha1_block_data_order_hw, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA1_ASM_AVX2)
    if (sha1_avx2_capable()) {
      CHECK_ABI(sha1_block_data_order_avx2, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA1_ASM_AVX)
    if (sha1_avx_capable()) {
      CHECK_ABI(sha1_block_data_order_avx, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA1_ASM_SSSE3)
    if (sha1_ssse3_capable()) {
      CHECK_ABI(sha1_block_data_order_ssse3, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA1_ASM_NEON)
    if (CRYPTO_is_NEON_capable()) {
      CHECK_ABI(sha1_block_data_order_neon, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA1_ASM_NOHW)
    CHECK_ABI(sha1_block_data_order_nohw, ctx.h, kBuf, blocks);
#endif
  }
}

TEST(SHATest, SHA256ABI) {
  SHA256_CTX ctx;
  SHA256_Init(&ctx);

  static const uint8_t kBuf[SHA256_CBLOCK * 8] = {0};
  for (size_t blocks : {1, 2, 4, 8}) {
#if defined(SHA256_ASM)
    CHECK_ABI(sha256_block_data_order, ctx.h, kBuf, blocks);
#endif
#if defined(SHA256_ASM_HW)
    if (sha256_hw_capable()) {
      CHECK_ABI(sha256_block_data_order_hw, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA256_ASM_AVX)
    if (sha256_avx_capable()) {
      CHECK_ABI(sha256_block_data_order_avx, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA256_ASM_SSSE3)
    if (sha256_ssse3_capable()) {
      CHECK_ABI(sha256_block_data_order_ssse3, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA256_ASM_NEON)
    if (CRYPTO_is_NEON_capable()) {
      CHECK_ABI(sha256_block_data_order_neon, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA256_ASM_NOHW)
    CHECK_ABI(sha256_block_data_order_nohw, ctx.h, kBuf, blocks);
#endif
  }
}

TEST(SHATest, SHA512ABI) {
  SHA512_CTX ctx;
  SHA512_Init(&ctx);

  static const uint8_t kBuf[SHA512_CBLOCK * 4] = {0};
  for (size_t blocks : {1, 2, 3, 4}) {
#if defined(SHA512_ASM)
    CHECK_ABI(sha512_block_data_order, ctx.h, kBuf, blocks);
#endif
#if defined(SHA512_ASM_HW)
    if (sha512_hw_capable()) {
      CHECK_ABI(sha512_block_data_order_hw, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA512_ASM_AVX)
    if (sha512_avx_capable()) {
      CHECK_ABI(sha512_block_data_order_avx, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA512_ASM_NEON)
    if (CRYPTO_is_NEON_capable()) {
      CHECK_ABI(sha512_block_data_order_neon, ctx.h, kBuf, blocks);
    }
#endif
#if defined(SHA512_ASM_NOHW)
    CHECK_ABI(sha512_block_data_order_nohw, ctx.h, kBuf, blocks);
#endif
  }
}

#endif  // SUPPORTS_ABI_TEST
