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

#include <stdio.h>

#include <vector>

#include <gtest/gtest.h>

#include <openssl/crypto.h>
#include <openssl/ec.h>
#include <openssl/ec_key.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

#include "../test/file_test.h"
#include "../test/wycheproof_util.h"


static void RunWycheproofTest(const char *path) {
  SCOPED_TRACE(path);
  FileTestGTest(path, [](FileTest *t) {
    t->IgnoreAllUnusedInstructions();

    const EC_GROUP *group = GetWycheproofCurve(t, "publicKey.curve", true);
    ASSERT_TRUE(group);
    std::vector<uint8_t> uncompressed;
    ASSERT_TRUE(
        t->GetInstructionBytes(&uncompressed, "publicKey.uncompressed"));
    bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
    ASSERT_TRUE(key);
    ASSERT_TRUE(EC_KEY_set_group(key.get(), group));
    ASSERT_TRUE(EC_KEY_oct2key(key.get(), uncompressed.data(),
                               uncompressed.size(), nullptr));

    const EVP_MD *md = GetWycheproofDigest(t, "sha", true);
    ASSERT_TRUE(md);

    std::vector<uint8_t> msg;
    ASSERT_TRUE(t->GetBytes(&msg, "msg"));
    std::vector<uint8_t> sig;
    ASSERT_TRUE(t->GetBytes(&sig, "sig"));
    WycheproofResult result;
    ASSERT_TRUE(GetWycheproofResult(t, &result));

    uint8_t digest[EVP_MAX_MD_SIZE];
    unsigned int digest_len;
    ASSERT_TRUE(
        EVP_Digest(msg.data(), msg.size(), digest, &digest_len, md, nullptr));

    int ret = ECDSA_verify_p1363(digest, digest_len, sig.data(), sig.size(),
                                 key.get());
    EXPECT_EQ(ret, result.IsValid() ? 1 : 0);
  });
}

TEST(ECDSAP1363Test, WycheproofP224) {
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp224r1_sha224_p1363_test.txt");
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp224r1_sha256_p1363_test.txt");
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp224r1_sha512_p1363_test.txt");
}

TEST(ECDSAP1363Test, WycheproofP256) {
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp256r1_sha256_p1363_test.txt");
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp256r1_sha512_p1363_test.txt");
}

TEST(ECDSAP1363Test, WycheproofP384) {
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp384r1_sha384_p1363_test.txt");
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp384r1_sha512_p1363_test.txt");
}

TEST(ECDSAP1363Test, WycheproofP521) {
  RunWycheproofTest(
      "third_party/wycheproof_testvectors/"
      "ecdsa_secp521r1_sha512_p1363_test.txt");
}


static void RunSignTest(const EC_GROUP *group) {
  // Fill digest values with some random data.
  uint8_t digest[20];
  ASSERT_TRUE(RAND_bytes(digest, sizeof(digest)));

  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_set_group(key.get(), group));
  ASSERT_TRUE(EC_KEY_generate_key(key.get()));

  size_t sig_len = ECDSA_size_p1363(key.get());
  ASSERT_GT(sig_len, 0u);
  std::vector<uint8_t> sig(sig_len);

  size_t out_sig_len;
  ASSERT_TRUE(ECDSA_sign_p1363(digest, sizeof(digest), sig.data(), &out_sig_len,
                               sig.size(), key.get()));
  ASSERT_EQ(out_sig_len, sig_len);

  ASSERT_TRUE(ECDSA_verify_p1363(digest, sizeof(digest), sig.data(), sig.size(),
                                 key.get()));
}

TEST(ECDSAP1363Test, SignP224) { RunSignTest(EC_group_p224()); }

TEST(ECDSAP1363Test, SignP256) { RunSignTest(EC_group_p256()); }

TEST(ECDSAP1363Test, SignP384) { RunSignTest(EC_group_p384()); }

TEST(ECDSAP1363Test, SignP521) { RunSignTest(EC_group_p521()); }

TEST(ECDSAP1363Test, SignFailsWithSmallBuffer) {
  // Fill digest values with some random data.
  uint8_t digest[20];
  ASSERT_TRUE(RAND_bytes(digest, sizeof(digest)));

  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_set_group(key.get(), EC_group_p256()));
  ASSERT_TRUE(EC_KEY_generate_key(key.get()));

  size_t sig_len = ECDSA_size_p1363(key.get());
  ASSERT_GT(sig_len, 0u);
  std::vector<uint8_t> sig(sig_len - 1);

  size_t out_sig_len;
  ASSERT_FALSE(ECDSA_sign_p1363(digest, sizeof(digest), sig.data(),
                                &out_sig_len, sig.size(), key.get()));
}

TEST(ECDSAP1363Test, SignSucceedsWithLargeBuffer) {
  // Fill digest values with some random data.
  uint8_t digest[20];
  ASSERT_TRUE(RAND_bytes(digest, sizeof(digest)));

  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  ASSERT_TRUE(key);
  ASSERT_TRUE(EC_KEY_set_group(key.get(), EC_group_p256()));
  ASSERT_TRUE(EC_KEY_generate_key(key.get()));

  size_t sig_len = ECDSA_size_p1363(key.get());
  ASSERT_GT(sig_len, 0u);
  std::vector<uint8_t> sig(sig_len + 1, 'x');

  size_t out_sig_len;
  ASSERT_TRUE(ECDSA_sign_p1363(digest, sizeof(digest), sig.data(), &out_sig_len,
                               sig.size(), key.get()));
  ASSERT_EQ(out_sig_len, sig_len);
  // The extra byte should be untouched.
  EXPECT_EQ(sig.back(), 'x');

  ASSERT_TRUE(ECDSA_verify_p1363(digest, sizeof(digest), sig.data(),
                                 out_sig_len, key.get()));
}

TEST(ECDSAP1363Test, SizeWithoutGroup) {
  EXPECT_EQ(ECDSA_size_p1363(nullptr), 0u);

  bssl::UniquePtr<EC_KEY> key(EC_KEY_new());
  EXPECT_EQ(ECDSA_size_p1363(key.get()), 0u);
}
