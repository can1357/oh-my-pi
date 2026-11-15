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

#include <openssl/cipher.h>

#include <gtest/gtest.h>

#include "../../crypto/internal.h"
#include "../../crypto/test/test_util.h"

struct BlowfishTestCase {
  uint8_t key[16];
  uint8_t plaintext[16];
  uint8_t iv[8];
  uint8_t ecb_ciphertext[16];
  uint8_t cbc_ciphertext[24];
  uint8_t cfb_ciphertext[16];
};

static const BlowfishTestCase kTests[] = {
    // Randomly generated test cases. Checked against vanilla OpenSSL.
    {
        {0xbb, 0x56, 0xb1, 0x27, 0x7c, 0x4c, 0xdd, 0x5a, 0x99, 0x90, 0x1e, 0x6f,
         0xeb, 0x36, 0x6c, 0xf3},
        {0xa6, 0x5b, 0xe0, 0x99, 0xad, 0x5d, 0x91, 0x98, 0x37, 0xc1, 0xa4, 0x7f,
         0x01, 0x24, 0x9a, 0x6b},
        {0xd5, 0x8a, 0x5c, 0x29, 0xeb, 0xee, 0xed, 0x76},
        {0xda, 0x6e, 0x18, 0x9c, 0x03, 0x59, 0x12, 0x61, 0xfa, 0x20, 0xd9, 0xce,
         0xee, 0x43, 0x9d, 0x05},
        {0x4f, 0x8b, 0x3e, 0x17, 0xa5, 0x35, 0x9b, 0xcb,
         0xdf, 0x3c, 0x52, 0xfb, 0xe5, 0x20, 0xdd, 0x53,
         0xd5, 0xf8, 0x1a, 0x6c, 0xf0, 0x99, 0x34, 0x94},
        {0xfd, 0x65, 0xc5, 0xa6, 0x07, 0x07, 0xb5, 0xf3, 0x2e, 0xfb, 0x12, 0xc3,
         0x7f, 0x45, 0x37, 0x54},
    },
    {
        {0x5d, 0x98, 0xa9, 0xd2, 0x27, 0x5d, 0xc8, 0x8c, 0x8c, 0xee, 0x23, 0x7f,
         0x8e, 0x2b, 0xd4, 0x8d},
        {0x60, 0xec, 0x31, 0xda, 0x25, 0x07, 0x02, 0x14, 0x84, 0x44, 0x96, 0xa6,
         0x04, 0x81, 0xca, 0x4e},
        {0x96, 0x4c, 0xa4, 0x07, 0xee, 0x1c, 0xd1, 0xfb},
        {0x83, 0x8a, 0xef, 0x18, 0x53, 0x96, 0xec, 0xf3, 0xf4, 0xd9, 0xe8, 0x4b,
         0x2c, 0x3f, 0xe7, 0x27},
        {0xad, 0x78, 0x70, 0x06, 0x2e, 0x5e, 0xa5, 0x21,
         0xdd, 0xe8, 0xa0, 0xb9, 0xdb, 0x0c, 0x81, 0x1d,
         0x0a, 0xd3, 0xa9, 0x63, 0x78, 0xac, 0x82, 0x64},
        {0x43, 0x2f, 0xf3, 0x23, 0xf4, 0x5c, 0xbf, 0x05, 0x53, 0x3c, 0x9e, 0xd6,
         0xd3, 0xd2, 0xc0, 0xf0},
    },
};

TEST(Blowfish, ECB) {
  unsigned test_num = 0;
  for (const auto &test : kTests) {
    test_num++;
    SCOPED_TRACE(test_num);

    uint8_t out[sizeof(test.ecb_ciphertext)];
    int out_bytes, final_bytes;

    bssl::ScopedEVP_CIPHER_CTX ctx;
    ASSERT_TRUE(EVP_EncryptInit_ex(ctx.get(), EVP_bf_ecb(), nullptr, test.key,
                                   nullptr));
    ASSERT_TRUE(EVP_CIPHER_CTX_set_padding(ctx.get(), 0 /* no padding */));
    ASSERT_TRUE(EVP_EncryptUpdate(ctx.get(), out, &out_bytes, test.plaintext,
                                  sizeof(test.plaintext)));
    ASSERT_TRUE(EVP_EncryptFinal_ex(ctx.get(), out + out_bytes, &final_bytes));
    EXPECT_EQ(static_cast<size_t>(out_bytes + final_bytes),
              sizeof(test.plaintext));
    EXPECT_EQ(Bytes(test.ecb_ciphertext), Bytes(out));

    bssl::ScopedEVP_CIPHER_CTX decrypt_ctx;
    ASSERT_TRUE(EVP_DecryptInit_ex(decrypt_ctx.get(), EVP_bf_ecb(), nullptr,
                                   test.key, nullptr));
    ASSERT_TRUE(
        EVP_CIPHER_CTX_set_padding(decrypt_ctx.get(), 0 /* no padding */));
    ASSERT_TRUE(EVP_DecryptUpdate(decrypt_ctx.get(), out, &out_bytes,
                                  test.ecb_ciphertext,
                                  sizeof(test.ecb_ciphertext)));
    ASSERT_TRUE(
        EVP_DecryptFinal_ex(decrypt_ctx.get(), out + out_bytes, &final_bytes));
    EXPECT_EQ(static_cast<size_t>(out_bytes + final_bytes),
              sizeof(test.plaintext));
    EXPECT_EQ(Bytes(test.plaintext), Bytes(out));
  }
}

TEST(Blowfish, CBC) {
  unsigned test_num = 0;
  for (const auto &test : kTests) {
    test_num++;
    SCOPED_TRACE(test_num);

    uint8_t out[sizeof(test.cbc_ciphertext)];
    int out_bytes, final_bytes;

    bssl::ScopedEVP_CIPHER_CTX ctx;
    ASSERT_TRUE(EVP_EncryptInit_ex(ctx.get(), EVP_bf_cbc(), nullptr, test.key,
                                   test.iv));
    ASSERT_TRUE(EVP_EncryptUpdate(ctx.get(), out, &out_bytes, test.plaintext,
                                  sizeof(test.plaintext)));
    EXPECT_TRUE(EVP_EncryptFinal_ex(ctx.get(), out + out_bytes, &final_bytes));
    EXPECT_EQ(static_cast<size_t>(out_bytes + final_bytes),
              sizeof(test.cbc_ciphertext));
    EXPECT_EQ(Bytes(test.cbc_ciphertext), Bytes(out));

    bssl::ScopedEVP_CIPHER_CTX decrypt_ctx;
    ASSERT_TRUE(EVP_DecryptInit_ex(decrypt_ctx.get(), EVP_bf_cbc(), nullptr,
                                   test.key, test.iv));
    ASSERT_TRUE(EVP_DecryptUpdate(decrypt_ctx.get(), out, &out_bytes,
                                  test.cbc_ciphertext,
                                  sizeof(test.cbc_ciphertext)));
    EXPECT_TRUE(
        EVP_DecryptFinal_ex(decrypt_ctx.get(), out + out_bytes, &final_bytes));
    EXPECT_EQ(static_cast<size_t>(out_bytes + final_bytes),
              sizeof(test.plaintext));
    EXPECT_EQ(Bytes(test.plaintext), Bytes(out, out_bytes + final_bytes));
  }
}

TEST(Blowfish, CFB) {
  unsigned test_num = 0;
  for (const auto &test : kTests) {
    test_num++;
    SCOPED_TRACE(test_num);

    uint8_t out[sizeof(test.cfb_ciphertext)];
    int out_bytes, final_bytes;

    bssl::ScopedEVP_CIPHER_CTX ctx;
    ASSERT_TRUE(EVP_EncryptInit_ex(ctx.get(), EVP_bf_cfb(), nullptr, test.key,
                                   test.iv));
    ASSERT_TRUE(EVP_EncryptUpdate(ctx.get(), out, &out_bytes, test.plaintext,
                                  sizeof(test.plaintext)));
    ASSERT_TRUE(EVP_EncryptFinal_ex(ctx.get(), out + out_bytes, &final_bytes));
    EXPECT_EQ(static_cast<size_t>(out_bytes + final_bytes),
              sizeof(test.plaintext));
    EXPECT_EQ(Bytes(test.cfb_ciphertext), Bytes(out));

    bssl::ScopedEVP_CIPHER_CTX decrypt_ctx;
    ASSERT_TRUE(EVP_DecryptInit_ex(decrypt_ctx.get(), EVP_bf_cfb(), nullptr,
                                   test.key, test.iv));
    ASSERT_TRUE(EVP_DecryptUpdate(decrypt_ctx.get(), out, &out_bytes,
                                  test.cfb_ciphertext,
                                  sizeof(test.cfb_ciphertext)));
    ASSERT_TRUE(
        EVP_DecryptFinal_ex(decrypt_ctx.get(), out + out_bytes, &final_bytes));
    EXPECT_EQ(static_cast<size_t>(out_bytes + final_bytes),
              sizeof(test.plaintext));
    EXPECT_EQ(Bytes(test.plaintext), Bytes(out));
  }
}
