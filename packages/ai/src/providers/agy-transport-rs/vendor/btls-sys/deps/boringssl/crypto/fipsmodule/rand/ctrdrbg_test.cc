// Copyright 2017 The BoringSSL Authors
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

#include <openssl/ctrdrbg.h>
#include <openssl/sha2.h>

#include "../../test/file_test.h"
#include "../../test/test_util.h"
#include "internal.h"


TEST(CTRDRBGTest, Basic) {
  const uint8_t kSeed[CTR_DRBG_ENTROPY_LEN] = {
      0xe4, 0xbc, 0x23, 0xc5, 0x08, 0x9a, 0x19, 0xd8, 0x6f, 0x41, 0x19, 0xcb,
      0x3f, 0xa0, 0x8c, 0x0a, 0x49, 0x91, 0xe0, 0xa1, 0xde, 0xf1, 0x7e, 0x10,
      0x1e, 0x4c, 0x14, 0xd9, 0xc3, 0x23, 0x46, 0x0a, 0x7c, 0x2f, 0xb5, 0x8e,
      0x0b, 0x08, 0x6c, 0x6c, 0x57, 0xb5, 0x5f, 0x56, 0xca, 0xe2, 0x5b, 0xad,
  };

  CTR_DRBG_STATE drbg;
  ASSERT_TRUE(CTR_DRBG_init(&drbg, /*df=*/false, kSeed, sizeof(kSeed), nullptr,
                            nullptr, 0));

  const uint8_t kReseed[CTR_DRBG_ENTROPY_LEN] = {
      0xfd, 0x85, 0xa8, 0x36, 0xbb, 0xa8, 0x50, 0x19, 0x88, 0x1e, 0x8c, 0x6b,
      0xad, 0x23, 0xc9, 0x06, 0x1a, 0xdc, 0x75, 0x47, 0x76, 0x59, 0xac, 0xae,
      0xa8, 0xe4, 0xa0, 0x1d, 0xfe, 0x07, 0xa1, 0x83, 0x2d, 0xad, 0x1c, 0x13,
      0x6f, 0x59, 0xd7, 0x0f, 0x86, 0x53, 0xa5, 0xdc, 0x11, 0x86, 0x63, 0xd6,
  };

  ASSERT_TRUE(CTR_DRBG_reseed_ex(&drbg, kReseed, sizeof(kSeed), nullptr, 0));

  uint8_t out[64];
  ASSERT_TRUE(CTR_DRBG_generate(&drbg, out, sizeof(out), nullptr, 0));
  ASSERT_TRUE(CTR_DRBG_generate(&drbg, out, sizeof(out), nullptr, 0));

  const uint8_t kExpected[64] = {
      0xb2, 0xcb, 0x89, 0x05, 0xc0, 0x5e, 0x59, 0x50, 0xca, 0x31, 0x89,
      0x50, 0x96, 0xbe, 0x29, 0xea, 0x3d, 0x5a, 0x3b, 0x82, 0xb2, 0x69,
      0x49, 0x55, 0x54, 0xeb, 0x80, 0xfe, 0x07, 0xde, 0x43, 0xe1, 0x93,
      0xb9, 0xe7, 0xc3, 0xec, 0xe7, 0x3b, 0x80, 0xe0, 0x62, 0xb1, 0xc1,
      0xf6, 0x82, 0x02, 0xfb, 0xb1, 0xc5, 0x2a, 0x04, 0x0e, 0xa2, 0x47,
      0x88, 0x64, 0x29, 0x52, 0x82, 0x23, 0x4a, 0xaa, 0xda,
  };

  EXPECT_EQ(Bytes(kExpected), Bytes(out));

  CTR_DRBG_clear(&drbg);
}

TEST(CTRDRBGTest, BasicDF) {
  const uint8_t kEntropy[32] = {
      0x36, 0x40, 0x19, 0x40, 0xfa, 0x8b, 0x1f, 0xba, 0x91, 0xa1, 0x66,
      0x1f, 0x21, 0x1d, 0x78, 0xa0, 0xb9, 0x38, 0x9a, 0x74, 0xe5, 0xbc,
      0xcf, 0xec, 0xe8, 0xd7, 0x66, 0xaf, 0x1a, 0x6d, 0x3b, 0x14,
  };
  const uint8_t kNonce[CTR_DRBG_NONCE_LEN] = {
      0x49, 0x6f, 0x25, 0xb0, 0xf1, 0x30, 0x1b, 0x4f,
      0x50, 0x1b, 0xe3, 0x03, 0x80, 0xa1, 0x37, 0xeb,
  };

  CTR_DRBG_STATE drbg;
  ASSERT_TRUE(CTR_DRBG_init(&drbg, /*df=*/true, kEntropy, sizeof(kEntropy),
                            kNonce, nullptr, 0));

  const uint8_t kReseed[CTR_DRBG_MIN_ENTROPY_LEN] = {
      0xfd, 0x85, 0xa8, 0x36, 0xbb, 0xa8, 0x50, 0x19, 0x88, 0x1e, 0x8c,
      0x6b, 0xad, 0x23, 0xc9, 0x06, 0x1a, 0xdc, 0x75, 0x47, 0x76, 0x59,
      0xac, 0xae, 0xa8, 0xe4, 0xa0, 0x1d, 0xfe, 0x07, 0xa1, 0x83,
  };

  ASSERT_TRUE(CTR_DRBG_reseed_ex(&drbg, kReseed, sizeof(kReseed), nullptr, 0));

  uint8_t out[64];
  ASSERT_TRUE(CTR_DRBG_generate(&drbg, out, sizeof(out), nullptr, 0));
  ASSERT_TRUE(CTR_DRBG_generate(&drbg, out, sizeof(out), nullptr, 0));

  const uint8_t kExpected[64] = {
      0xf5, 0xad, 0x51, 0x3c, 0x3c, 0x20, 0x6c, 0x8b, 0xaf, 0x2c, 0x7b,
      0xf8, 0x9f, 0xc8, 0xb1, 0x0c, 0x42, 0x48, 0x8b, 0xa4, 0x14, 0x07,
      0xc0, 0x3f, 0xcf, 0xb6, 0xcf, 0x3b, 0x27, 0x4d, 0xca, 0x9a, 0xff,
      0xfd, 0xf3, 0x22, 0xe8, 0xb0, 0x6d, 0xa2, 0xd1, 0x78, 0x16, 0x0b,
      0x84, 0xd6, 0xf5, 0x94, 0x4f, 0x43, 0x27, 0xbd, 0x5d, 0x16, 0x23,
      0x01, 0xbd, 0x88, 0xfe, 0xc3, 0x26, 0xfe, 0x0e, 0x64,
  };

  EXPECT_EQ(Bytes(kExpected), Bytes(out));

  CTR_DRBG_clear(&drbg);
}

TEST(CTRDRBGTest, Allocated) {
  const uint8_t kEntropy[32] = {0};
  const uint8_t kNonce[CTR_DRBG_NONCE_LEN] = {0};

  bssl::UniquePtr<CTR_DRBG_STATE> allocated(
      CTR_DRBG_new_df(kEntropy, sizeof(kEntropy), kNonce, nullptr, 0));
  ASSERT_TRUE(allocated);

  allocated.reset(
      CTR_DRBG_new_df(kEntropy, sizeof(kEntropy), kNonce, nullptr, 1 << 20));
  ASSERT_FALSE(allocated);
}

TEST(CTRDRBGTest, Large) {
  const uint8_t kEntropy[32] = {0};
  const uint8_t kNonce[CTR_DRBG_NONCE_LEN] = {0};

  CTR_DRBG_STATE drbg;
  ASSERT_TRUE(CTR_DRBG_init(&drbg, /*df=*/true, kEntropy, sizeof(kEntropy),
                            kNonce, nullptr, 0));

  auto buf = std::make_unique<uint8_t[]>(CTR_DRBG_MAX_GENERATE_LENGTH);
  ASSERT_TRUE(CTR_DRBG_generate(&drbg, buf.get(), CTR_DRBG_MAX_GENERATE_LENGTH,
                                nullptr, 0));

  uint8_t digest[SHA256_DIGEST_LENGTH];
  SHA256(buf.get(), CTR_DRBG_MAX_GENERATE_LENGTH, digest);

  const uint8_t kExpected[SHA256_DIGEST_LENGTH] = {
      0x17, 0xd1, 0x3f, 0x6b, 0x0a, 0x0c, 0x94, 0xc5, 0xbe, 0x4f, 0xd9,
      0xec, 0xfb, 0x61, 0x60, 0x11, 0xa0, 0x4a, 0x38, 0x2b, 0x14, 0x2c,
      0xc4, 0xfd, 0x58, 0xdc, 0x0a, 0xec, 0x7e, 0xb9, 0x68, 0x6c,
  };
  EXPECT_EQ(Bytes(kExpected), Bytes(digest));

  CTR_DRBG_clear(&drbg);
}

static void RunTestVector(FileTest *t, bool df) {
  std::vector<uint8_t> entropy, nonce, personalisation, reseed, ai_reseed, ai1,
      ai2, expected;
  ASSERT_TRUE(t->GetBytes(&entropy, "EntropyInput"));
  if (df) {
    ASSERT_TRUE(t->GetBytes(&nonce, "Nonce"));
  }
  ASSERT_TRUE(t->GetBytes(&personalisation, "PersonalizationString"));
  ASSERT_TRUE(t->GetBytes(&reseed, "EntropyInputReseed"));
  ASSERT_TRUE(t->GetBytes(&ai_reseed, "AdditionalInputReseed"));
  ASSERT_TRUE(t->GetBytes(&ai1, "AdditionalInput1"));
  ASSERT_TRUE(t->GetBytes(&ai2, "AdditionalInput2"));
  ASSERT_TRUE(t->GetBytes(&expected, "ReturnedBits"));

  if (df) {
    ASSERT_LE(entropy.size(), static_cast<size_t>(CTR_DRBG_MAX_ENTROPY_LEN));
    ASSERT_GE(entropy.size(), static_cast<size_t>(CTR_DRBG_MIN_ENTROPY_LEN));
    ASSERT_LE(reseed.size(), static_cast<size_t>(CTR_DRBG_MAX_ENTROPY_LEN));
    ASSERT_GE(reseed.size(), static_cast<size_t>(CTR_DRBG_MIN_ENTROPY_LEN));
    ASSERT_EQ(static_cast<size_t>(CTR_DRBG_NONCE_LEN), nonce.size());
  } else {
    ASSERT_EQ(nonce.size(), 0u);
    ASSERT_EQ(static_cast<size_t>(CTR_DRBG_ENTROPY_LEN), entropy.size());
    ASSERT_EQ(static_cast<size_t>(CTR_DRBG_ENTROPY_LEN), reseed.size());
  }

  CTR_DRBG_STATE drbg;
  CTR_DRBG_init(&drbg, df, entropy.data(), entropy.size(),
                nonce.empty() ? nullptr : nonce.data(), personalisation.data(),
                personalisation.size());
  CTR_DRBG_reseed_ex(&drbg, reseed.data(), reseed.size(),
                     ai_reseed.empty() ? nullptr : ai_reseed.data(),
                     ai_reseed.size());

  std::vector<uint8_t> out(expected.size());
  CTR_DRBG_generate(&drbg, out.data(), out.size(), ai1.data(), ai1.size());
  CTR_DRBG_generate(&drbg, out.data(), out.size(), ai2.data(), ai2.size());

  EXPECT_EQ(Bytes(expected), Bytes(out));
}

TEST(CTRDRBGTest, TestVectors) {
  FileTestGTest("crypto/fipsmodule/rand/ctrdrbg_vectors.txt",
                [](FileTest *t) { RunTestVector(t, /*df=*/false); });
}

TEST(CTRDRBGTest, TestVectorsDF) {
  FileTestGTest("crypto/fipsmodule/rand/ctrdrbg_df_vectors.txt",
                [](FileTest *t) { RunTestVector(t, /*df=*/true); });
}
