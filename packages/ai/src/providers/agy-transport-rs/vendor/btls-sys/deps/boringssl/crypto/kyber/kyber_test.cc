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

#include <vector>

#include <string.h>

#include <gtest/gtest.h>

#include <openssl/bytestring.h>
#include <openssl/ctrdrbg.h>

#include "../fipsmodule/keccak/internal.h"
#include "../test/file_test.h"
#include "../test/test_util.h"
#include "./internal.h"


template <typename T>
static std::vector<uint8_t> Marshal(int (*marshal_func)(CBB *, const T *),
                                    const T *t) {
  bssl::ScopedCBB cbb;
  uint8_t *encoded;
  size_t encoded_len;
  if (!CBB_init(cbb.get(), 1) ||      //
      !marshal_func(cbb.get(), t) ||  //
      !CBB_finish(cbb.get(), &encoded, &encoded_len)) {
    abort();
  }

  std::vector<uint8_t> ret(encoded, encoded + encoded_len);
  OPENSSL_free(encoded);
  return ret;
}

TEST(KyberTest, Basic) {
  // This function makes several Kyber keys, which runs up against stack limits.
  // Heap-allocate them instead.

  uint8_t encoded_public_key[KYBER_PUBLIC_KEY_BYTES];
  auto priv = std::make_unique<KYBER_private_key>();
  KYBER_generate_key(encoded_public_key, priv.get());

  uint8_t first_two_bytes[2];
  OPENSSL_memcpy(first_two_bytes, encoded_public_key, sizeof(first_two_bytes));
  OPENSSL_memset(encoded_public_key, 0xff, sizeof(first_two_bytes));
  CBS encoded_public_key_cbs;
  CBS_init(&encoded_public_key_cbs, encoded_public_key,
           sizeof(encoded_public_key));
  auto pub = std::make_unique<KYBER_public_key>();
  // Parsing should fail because the first coefficient is >= kPrime;
  ASSERT_FALSE(KYBER_parse_public_key(pub.get(), &encoded_public_key_cbs));

  OPENSSL_memcpy(encoded_public_key, first_two_bytes, sizeof(first_two_bytes));
  CBS_init(&encoded_public_key_cbs, encoded_public_key,
           sizeof(encoded_public_key));
  ASSERT_TRUE(KYBER_parse_public_key(pub.get(), &encoded_public_key_cbs));
  EXPECT_EQ(CBS_len(&encoded_public_key_cbs), 0u);

  EXPECT_EQ(Bytes(encoded_public_key),
            Bytes(Marshal(KYBER_marshal_public_key, pub.get())));

  auto pub2 = std::make_unique<KYBER_public_key>();
  KYBER_public_from_private(pub2.get(), priv.get());
  EXPECT_EQ(Bytes(encoded_public_key),
            Bytes(Marshal(KYBER_marshal_public_key, pub2.get())));

  std::vector<uint8_t> encoded_private_key(
      Marshal(KYBER_marshal_private_key, priv.get()));
  EXPECT_EQ(encoded_private_key.size(), size_t{KYBER_PRIVATE_KEY_BYTES});

  OPENSSL_memcpy(first_two_bytes, encoded_private_key.data(),
                 sizeof(first_two_bytes));
  OPENSSL_memset(encoded_private_key.data(), 0xff, sizeof(first_two_bytes));
  CBS cbs;
  CBS_init(&cbs, encoded_private_key.data(), encoded_private_key.size());
  auto priv2 = std::make_unique<KYBER_private_key>();
  // Parsing should fail because the first coefficient is >= kPrime.
  ASSERT_FALSE(KYBER_parse_private_key(priv2.get(), &cbs));

  OPENSSL_memcpy(encoded_private_key.data(), first_two_bytes,
                 sizeof(first_two_bytes));
  CBS_init(&cbs, encoded_private_key.data(), encoded_private_key.size());
  ASSERT_TRUE(KYBER_parse_private_key(priv2.get(), &cbs));
  EXPECT_EQ(
      Bytes(Declassified(encoded_private_key)),
      Bytes(Declassified((Marshal(KYBER_marshal_private_key, priv2.get())))));

  uint8_t ciphertext[KYBER_CIPHERTEXT_BYTES];
  uint8_t shared_secret1[KYBER_SHARED_SECRET_BYTES];
  uint8_t shared_secret2[KYBER_SHARED_SECRET_BYTES];
  KYBER_encap(ciphertext, shared_secret1, pub.get());
  KYBER_decap(shared_secret2, ciphertext, priv.get());
  EXPECT_EQ(Bytes(Declassified(shared_secret1)),
            Bytes(Declassified(shared_secret2)));
  KYBER_decap(shared_secret2, ciphertext, priv2.get());
  EXPECT_EQ(Bytes(Declassified(shared_secret1)),
            Bytes(Declassified(shared_secret2)));
}

static void KyberFileTest(FileTest *t) {
  std::vector<uint8_t> public_key_expected, private_key_expected,
      ciphertext_expected, shared_secret_expected, generate_entropy,
      encap_entropy_pre_hash;
  t->IgnoreAttribute("count");
  ASSERT_TRUE(t->GetBytes(&public_key_expected, "pk"));
  ASSERT_TRUE(t->GetBytes(&private_key_expected, "sk"));
  ASSERT_TRUE(t->GetBytes(&ciphertext_expected, "ct"));
  ASSERT_TRUE(t->GetBytes(&shared_secret_expected, "ss"));
  ASSERT_TRUE(t->GetBytes(&generate_entropy, "generateEntropy"));
  ASSERT_TRUE(t->GetBytes(&encap_entropy_pre_hash, "encapEntropyPreHash"));

  KYBER_private_key priv;
  uint8_t encoded_private_key[KYBER_PRIVATE_KEY_BYTES];
  KYBER_public_key pub;
  uint8_t encoded_public_key[KYBER_PUBLIC_KEY_BYTES];
  uint8_t ciphertext[KYBER_CIPHERTEXT_BYTES];
  uint8_t encap_entropy[KYBER_ENCAP_ENTROPY];
  uint8_t encapsulated_key[KYBER_SHARED_SECRET_BYTES];
  uint8_t decapsulated_key[KYBER_SHARED_SECRET_BYTES];

  BORINGSSL_keccak(encap_entropy, sizeof(encap_entropy),
                   encap_entropy_pre_hash.data(), encap_entropy_pre_hash.size(),
                   boringssl_sha3_256);

  KYBER_generate_key_external_entropy(encoded_public_key, &priv,
                                      generate_entropy.data());
  CBB cbb;
  CBB_init_fixed(&cbb, encoded_private_key, sizeof(encoded_private_key));
  ASSERT_TRUE(KYBER_marshal_private_key(&cbb, &priv));
  CBS encoded_public_key_cbs;
  CBS_init(&encoded_public_key_cbs, encoded_public_key,
           sizeof(encoded_public_key));
  ASSERT_TRUE(KYBER_parse_public_key(&pub, &encoded_public_key_cbs));
  KYBER_encap_external_entropy(ciphertext, encapsulated_key, &pub,
                               encap_entropy);
  KYBER_decap(decapsulated_key, ciphertext, &priv);

  EXPECT_EQ(Bytes(Declassified(encapsulated_key)),
            Bytes(Declassified(decapsulated_key)));
  EXPECT_EQ(Bytes(private_key_expected),
            Bytes(Declassified(encoded_private_key)));
  EXPECT_EQ(Bytes(public_key_expected), Bytes(encoded_public_key));
  EXPECT_EQ(Bytes(ciphertext_expected), Bytes(ciphertext));
  EXPECT_EQ(Bytes(shared_secret_expected),
            Bytes(Declassified(encapsulated_key)));

  uint8_t corrupted_ciphertext[KYBER_CIPHERTEXT_BYTES];
  OPENSSL_memcpy(corrupted_ciphertext, ciphertext, KYBER_CIPHERTEXT_BYTES);
  corrupted_ciphertext[3] ^= 0x40;
  uint8_t corrupted_decapsulated_key[KYBER_SHARED_SECRET_BYTES];
  KYBER_decap(corrupted_decapsulated_key, corrupted_ciphertext, &priv);
  // It would be nice to have actual test vectors for the failure case, but the
  // NIST submission currently does not include those, so we are just testing
  // for inequality.
  EXPECT_NE(Bytes(Declassified(encapsulated_key)),
            Bytes(Declassified(corrupted_decapsulated_key)));
}

TEST(KyberTest, TestVectors) {
  FileTestGTest("crypto/kyber/kyber_tests.txt", KyberFileTest);
}
