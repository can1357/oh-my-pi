// Copyright 2024 The BoringSSL Authors
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

#include <openssl/base.h>

#include <cstdint>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <openssl/obj.h>
#include <openssl/slhdsa.h>

#include "../fipsmodule/slhdsa/params.h"
#include "../test/file_test.h"
#include "../test/test_util.h"

namespace {

TEST(SLHDSATest, KeyGeneration) {
  const uint8_t seed[3 * BCM_SLHDSA_SHA2_128S_N] = {0};
  const uint8_t expected_pub[] = {
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0xbe, 0x6b, 0xd7, 0xe8, 0xe1, 0x98,
      0xea, 0xf6, 0x2d, 0x57, 0x2f, 0x13, 0xfc, 0x79, 0xf2, 0x6f,
  };
  const uint8_t expected_priv[] = {
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0xbe, 0x6b, 0xd7, 0xe8, 0xe1, 0x98, 0xea,
      0xf6, 0x2d, 0x57, 0x2f, 0x13, 0xfc, 0x79, 0xf2, 0x6f,
  };

  uint8_t pub[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES];
  uint8_t priv[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
  BCM_slhdsa_sha2_128s_generate_key_from_seed(pub, priv, seed);
  EXPECT_EQ(Bytes(pub), Bytes(expected_pub));
  EXPECT_EQ(Bytes(priv), Bytes(expected_priv));

  uint8_t pub2[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES];
  SLHDSA_SHA2_128S_public_from_private(pub2, priv);
  EXPECT_EQ(Bytes(pub2), Bytes(expected_pub));
}

TEST(SLHDSATest, BasicSignVerify) {
  uint8_t pub[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES];
  uint8_t priv[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
  SLHDSA_SHA2_128S_generate_key(pub, priv);

  uint8_t kMessage[] = {0x42};
  uint8_t kContext[256] = {0};
  uint8_t signature[SLHDSA_SHA2_128S_SIGNATURE_BYTES];
  ASSERT_TRUE(SLHDSA_SHA2_128S_sign(signature, priv, kMessage, sizeof(kMessage),
                                    nullptr, 0));
  EXPECT_EQ(SLHDSA_SHA2_128S_verify(signature, sizeof(signature), pub, kMessage,
                                    sizeof(kMessage), nullptr, 0),
            1);
  EXPECT_EQ(SLHDSA_SHA2_128S_verify(signature, sizeof(signature), pub, kMessage,
                                    sizeof(kMessage), kContext, 1),
            0);
  EXPECT_EQ(SLHDSA_SHA2_128S_verify(signature, sizeof(signature), pub, kMessage,
                                    sizeof(kMessage), kContext, 256),
            0);

  ASSERT_TRUE(SLHDSA_SHA2_128S_sign(signature, priv, kMessage, sizeof(kMessage),
                                    kContext, 1));
  EXPECT_EQ(SLHDSA_SHA2_128S_verify(signature, sizeof(signature), pub, kMessage,
                                    sizeof(kMessage), kContext, 1),
            1);
}

TEST(SLHDSATest, BasicNonstandardPrehashSignVerify) {
  uint8_t pub[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES];
  uint8_t priv[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
  SLHDSA_SHA2_128S_generate_key(pub, priv);

  // Use a constant 48-byte value as the prehashed message
  uint8_t kHashedMessage[48] = {0x42};
  uint8_t kContext[256] = {0};
  uint8_t signature[SLHDSA_SHA2_128S_SIGNATURE_BYTES];
  ASSERT_TRUE(SLHDSA_SHA2_128S_prehash_warning_nonstandard_sign(
      signature, priv, kHashedMessage, sizeof(kHashedMessage), NID_sha384,
      nullptr, 0));
  EXPECT_EQ(SLHDSA_SHA2_128S_prehash_warning_nonstandard_verify(
                signature, sizeof(signature), pub, kHashedMessage,
                sizeof(kHashedMessage), NID_sha384, nullptr, 0),
            1);
  EXPECT_EQ(SLHDSA_SHA2_128S_prehash_warning_nonstandard_verify(
                signature, sizeof(signature), pub, kHashedMessage,
                sizeof(kHashedMessage), NID_sha384, kContext, 1),
            0);
  EXPECT_EQ(SLHDSA_SHA2_128S_prehash_warning_nonstandard_verify(
                signature, sizeof(signature), pub, kHashedMessage,
                sizeof(kHashedMessage), NID_sha384, kContext, 256),
            0);

  ASSERT_TRUE(SLHDSA_SHA2_128S_prehash_warning_nonstandard_sign(
      signature, priv, kHashedMessage, sizeof(kHashedMessage), NID_sha384,
      kContext, 1));
  EXPECT_EQ(SLHDSA_SHA2_128S_prehash_warning_nonstandard_verify(
                signature, sizeof(signature), pub, kHashedMessage,
                sizeof(kHashedMessage), NID_sha384, kContext, 1),
            1);

  uint8_t kWrongLengthHash[16] = {0x42};
  EXPECT_FALSE(SLHDSA_SHA2_128S_prehash_warning_nonstandard_sign(
      signature, priv, kWrongLengthHash, sizeof(kWrongLengthHash), NID_sha384,
      nullptr, 0));
}

static void NISTKeyGenerationFileTest(FileTest *t) {
  std::vector<uint8_t> seed, expected_pub, expected_priv;
  ASSERT_TRUE(t->GetBytes(&seed, "seed"));
  ASSERT_EQ(seed.size(), 48u);
  ASSERT_TRUE(t->GetBytes(&expected_pub, "pub"));
  ASSERT_TRUE(t->GetBytes(&expected_priv, "priv"));

  uint8_t pub[SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES];
  uint8_t priv[SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
  BCM_slhdsa_sha2_128s_generate_key_from_seed(pub, priv, seed.data());

  EXPECT_EQ(Bytes(pub), Bytes(expected_pub));
  EXPECT_EQ(Bytes(priv), Bytes(expected_priv));
}

TEST(SLHDSATest, NISTKeyGeneration) {
  FileTestGTest("crypto/slhdsa/slhdsa_keygen.txt", NISTKeyGenerationFileTest);
}

static void NISTSignatureGenerationFileTest(FileTest *t) {
  std::vector<uint8_t> priv, entropy, msg, expected_sig;
  ASSERT_TRUE(t->GetBytes(&priv, "priv"));
  ASSERT_EQ(priv.size(),
            static_cast<size_t>(SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES));
  ASSERT_TRUE(t->GetBytes(&entropy, "entropy"));
  ASSERT_EQ(entropy.size(), static_cast<size_t>(BCM_SLHDSA_SHA2_128S_N));
  ASSERT_TRUE(t->GetBytes(&msg, "msg"));
  ASSERT_TRUE(t->GetBytes(&expected_sig, "sig"));

  uint8_t sig[SLHDSA_SHA2_128S_SIGNATURE_BYTES];
  BCM_slhdsa_sha2_128s_sign_internal(sig, priv.data(), nullptr, nullptr, 0,
                                     msg.data(), msg.size(), entropy.data());

  EXPECT_EQ(Bytes(sig), Bytes(expected_sig));
}

TEST(SLHDSATest, NISTSignatureGeneration) {
  FileTestGTest("crypto/slhdsa/slhdsa_siggen.txt",
                NISTSignatureGenerationFileTest);
}

static void NISTSignatureVerificationFileTest(FileTest *t) {
  std::vector<uint8_t> pub, msg, sig;
  std::string valid;
  ASSERT_TRUE(t->GetBytes(&pub, "pub"));
  ASSERT_EQ(pub.size(), static_cast<size_t>(SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES));
  ASSERT_TRUE(t->GetBytes(&msg, "msg"));
  ASSERT_TRUE(t->GetBytes(&sig, "sig"));
  ASSERT_TRUE(t->GetAttribute(&valid, "valid"));

  int ok = bcm_success(BCM_slhdsa_sha2_128s_verify_internal(
      sig.data(), sig.size(), pub.data(), nullptr, nullptr, 0, msg.data(),
      msg.size()));
  EXPECT_EQ(ok, valid == "true");
}

TEST(SLHDSATest, NISTSignatureVerification) {
  FileTestGTest("crypto/slhdsa/slhdsa_sigver.txt",
                NISTSignatureVerificationFileTest);
}

static void NISTPrehashSignatureVerificationFileTest(FileTest *t) {
  std::vector<uint8_t> pub, msg, sig, context;
  ASSERT_TRUE(t->GetBytes(&pub, "pub"));
  ASSERT_EQ(pub.size(), static_cast<size_t>(SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES));
  ASSERT_TRUE(t->GetBytes(&msg, "msg"));
  ASSERT_TRUE(t->GetBytes(&sig, "sig"));
  ASSERT_EQ(sig.size(), size_t{SLHDSA_SHA2_128S_SIGNATURE_BYTES});
  ASSERT_TRUE(t->GetBytes(&context, "context"));

  std::string hash_func;
  ASSERT_TRUE(t->GetAttribute(&hash_func, "hash"));
  int nid = 0;
  bool nonstandard = false;
  if (hash_func == "SHA-256") {
    nid = NID_sha256;
  } else if (hash_func == "SHA-384") {
    nid = NID_sha384;
    nonstandard = true;
  } else {
    abort();
  }

  if (nonstandard) {
    EXPECT_TRUE(SLHDSA_SHA2_128S_prehash_warning_nonstandard_verify(
        sig.data(), sig.size(), pub.data(), msg.data(), msg.size(), nid,
        context.data(), context.size()));
  } else {
    EXPECT_TRUE(SLHDSA_SHA2_128S_prehash_verify(
        sig.data(), sig.size(), pub.data(), msg.data(), msg.size(), nid,
        context.data(), context.size()));
  }
}

TEST(SLHDSATest, NISTPrehashSignatureVerification) {
  FileTestGTest("crypto/slhdsa/slhdsa_prehash.txt",
                NISTPrehashSignatureVerificationFileTest);
}

TEST(SLHDSATest, Self) { boringssl_self_test_slhdsa(); }

TEST(SLHDSATest, NullptrArgumentsToCreate) {
  // For FIPS reasons, this should fail rather than crash.
  ASSERT_EQ(BCM_slhdsa_sha2_128s_generate_key_fips(nullptr, nullptr),
            bcm_status::failure);
  ASSERT_EQ(BCM_slhdsa_sha2_128s_generate_key_from_seed_fips(nullptr, nullptr,
                                                             nullptr),
            bcm_status::failure);
}

}  // namespace
