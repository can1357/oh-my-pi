// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <memory>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include <openssl/digest.h>
#include <openssl/hmac.h>

#include "../test/file_test.h"
#include "../test/test_util.h"
#include "../test/wycheproof_util.h"


static const EVP_MD *GetDigest(const std::string &name) {
  if (name == "MD5") {
    return EVP_md5();
  } else if (name == "SHA1") {
    return EVP_sha1();
  } else if (name == "SHA224") {
    return EVP_sha224();
  } else if (name == "SHA256") {
    return EVP_sha256();
  } else if (name == "SHA384") {
    return EVP_sha384();
  } else if (name == "SHA512") {
    return EVP_sha512();
  }
  return nullptr;
}

TEST(HMACTest, TestVectors) {
  FileTestGTest("crypto/hmac/hmac_tests.txt", [](FileTest *t) {
    std::string digest_str;
    ASSERT_TRUE(t->GetAttribute(&digest_str, "HMAC"));
    const EVP_MD *digest = GetDigest(digest_str);
    ASSERT_TRUE(digest) << "Unknown digest: " << digest_str;

    std::vector<uint8_t> key, input, output;
    ASSERT_TRUE(t->GetBytes(&key, "Key"));
    ASSERT_TRUE(t->GetBytes(&input, "Input"));
    ASSERT_TRUE(t->GetBytes(&output, "Output"));
    ASSERT_EQ(EVP_MD_size(digest), output.size());

    // Test using the one-shot API.
    auto mac = std::make_unique<uint8_t[]>(EVP_MD_size(digest));
    unsigned mac_len;
    ASSERT_TRUE(HMAC(digest, key.data(), key.size(), input.data(), input.size(),
                     mac.get(), &mac_len));
    EXPECT_EQ(Bytes(output), Bytes(mac.get(), mac_len));

    // Test using HMAC_CTX.
    bssl::ScopedHMAC_CTX ctx;
    ASSERT_TRUE(
        HMAC_Init_ex(ctx.get(), key.data(), key.size(), digest, nullptr));
    ASSERT_TRUE(HMAC_Update(ctx.get(), input.data(), input.size()));
    ASSERT_TRUE(HMAC_Final(ctx.get(), mac.get(), &mac_len));
    EXPECT_EQ(Bytes(output), Bytes(mac.get(), mac_len));

    // Test that an HMAC_CTX may be reset with the same key.
    ASSERT_TRUE(HMAC_Init_ex(ctx.get(), nullptr, 0, digest, nullptr));
    ASSERT_TRUE(HMAC_Update(ctx.get(), input.data(), input.size()));
    ASSERT_TRUE(HMAC_Final(ctx.get(), mac.get(), &mac_len));
    EXPECT_EQ(Bytes(output), Bytes(mac.get(), mac_len));

    // Test feeding the input in byte by byte.
    ASSERT_TRUE(HMAC_Init_ex(ctx.get(), nullptr, 0, nullptr, nullptr));
    for (size_t i = 0; i < input.size(); i++) {
      ASSERT_TRUE(HMAC_Update(ctx.get(), &input[i], 1));
    }
    ASSERT_TRUE(HMAC_Final(ctx.get(), mac.get(), &mac_len));
    EXPECT_EQ(Bytes(output), Bytes(mac.get(), mac_len));
  });
}

static void RunWycheproofTest(const char *path, const EVP_MD *md) {
  SCOPED_TRACE(path);
  FileTestGTest(path, [&](FileTest *t) {
    t->IgnoreInstruction("keySize");
    t->IgnoreInstruction("tagSize");
    std::vector<uint8_t> key, msg, tag;
    ASSERT_TRUE(t->GetBytes(&key, "key"));
    ASSERT_TRUE(t->GetBytes(&msg, "msg"));
    ASSERT_TRUE(t->GetBytes(&tag, "tag"));
    WycheproofResult result;
    ASSERT_TRUE(GetWycheproofResult(t, &result));

    if (!result.IsValid()) {
      // Wycheproof tests assume the HMAC implementation checks the MAC. Ours
      // simply computes the HMAC, so skip the tests with invalid outputs.
      return;
    }

    uint8_t out[EVP_MAX_MD_SIZE];
    unsigned out_len;
    ASSERT_TRUE(HMAC(md, key.data(), key.size(), msg.data(), msg.size(), out,
                     &out_len));
    // Wycheproof tests truncate the tags down to |tagSize|.
    ASSERT_LE(tag.size(), out_len);
    EXPECT_EQ(Bytes(out, tag.size()), Bytes(tag));
  });
}

TEST(HMACTest, WycheproofSHA1) {
  RunWycheproofTest("third_party/wycheproof_testvectors/hmac_sha1_test.txt",
                    EVP_sha1());
}

TEST(HMACTest, WycheproofSHA224) {
  RunWycheproofTest("third_party/wycheproof_testvectors/hmac_sha224_test.txt",
                    EVP_sha224());
}

TEST(HMACTest, WycheproofSHA256) {
  RunWycheproofTest("third_party/wycheproof_testvectors/hmac_sha256_test.txt",
                    EVP_sha256());
}

TEST(HMACTest, WycheproofSHA384) {
  RunWycheproofTest("third_party/wycheproof_testvectors/hmac_sha384_test.txt",
                    EVP_sha384());
}

TEST(HMACTest, WycheproofSHA512) {
  RunWycheproofTest("third_party/wycheproof_testvectors/hmac_sha512_test.txt",
                    EVP_sha512());
}
