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

#include <cstdint>
#include <vector>

#include <string.h>

#include <gtest/gtest.h>

#include <openssl/base.h>
#include <openssl/bytestring.h>
#include <openssl/mem.h>
#include <openssl/mlkem.h>

#include "../fipsmodule/bcm_interface.h"
#include "../fipsmodule/keccak/internal.h"
#include "../internal.h"
#include "../test/file_test.h"
#include "../test/test_util.h"


namespace {

template <typename T>
std::vector<uint8_t> Marshal(int (*marshal_func)(CBB *, const T *),
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

// These functions wrap the methods that are only in the BCM interface. They
// take care of casting the key types from the public keys to the BCM types.
// That saves casting noise in the template functions.

int wrapper_768_marshal_private_key(CBB *out,
                                    const MLKEM768_private_key *private_key) {
  return bcm_success(BCM_mlkem768_marshal_private_key(out, private_key));
}

int wrapper_1024_marshal_private_key(CBB *out,
                                     const MLKEM1024_private_key *private_key) {
  return bcm_success(BCM_mlkem1024_marshal_private_key(out, private_key));
}

void wrapper_768_generate_key_external_seed(
    uint8_t out_encoded_public_key[MLKEM768_PUBLIC_KEY_BYTES],
    struct MLKEM768_private_key *out_private_key,
    const uint8_t seed[MLKEM_SEED_BYTES]) {
  BCM_mlkem768_generate_key_external_seed(out_encoded_public_key,
                                          out_private_key, seed);
}

void wrapper_1024_generate_key_external_seed(
    uint8_t out_encoded_public_key[MLKEM1024_PUBLIC_KEY_BYTES],
    struct MLKEM1024_private_key *out_private_key,
    const uint8_t seed[MLKEM_SEED_BYTES]) {
  BCM_mlkem1024_generate_key_external_seed(out_encoded_public_key,
                                           out_private_key, seed);
}

void wrapper_768_encap_external_entropy(
    uint8_t out_ciphertext[MLKEM768_CIPHERTEXT_BYTES],
    uint8_t out_shared_secret[MLKEM_SHARED_SECRET_BYTES],
    const MLKEM768_public_key *public_key,
    const uint8_t entropy[BCM_MLKEM_ENCAP_ENTROPY]) {
  BCM_mlkem768_encap_external_entropy(out_ciphertext, out_shared_secret,
                                      public_key, entropy);
}

void wrapper_1024_encap_external_entropy(
    uint8_t out_ciphertext[MLKEM1024_CIPHERTEXT_BYTES],
    uint8_t out_shared_secret[MLKEM_SHARED_SECRET_BYTES],
    const MLKEM1024_public_key *public_key,
    const uint8_t entropy[BCM_MLKEM_ENCAP_ENTROPY]) {
  BCM_mlkem1024_encap_external_entropy(out_ciphertext, out_shared_secret,
                                       public_key, entropy);
}

int wrapper_768_parse_private_key(struct MLKEM768_private_key *out_private_key,
                                  CBS *in) {
  return bcm_success(BCM_mlkem768_parse_private_key(out_private_key, in));
}

int wrapper_1024_parse_private_key(
    struct MLKEM1024_private_key *out_private_key, CBS *in) {
  return bcm_success(BCM_mlkem1024_parse_private_key(out_private_key, in));
}

template <typename PUBLIC_KEY, size_t PUBLIC_KEY_BYTES, typename PRIVATE_KEY,
          size_t PRIVATE_KEY_BYTES,
          void (*GENERATE)(uint8_t *, uint8_t *, PRIVATE_KEY *),
          int (*FROM_SEED)(PRIVATE_KEY *, const uint8_t *, size_t),
          void (*PUBLIC_FROM_PRIVATE)(PUBLIC_KEY *, const PRIVATE_KEY *),
          int (*PARSE_PUBLIC)(PUBLIC_KEY *, CBS *),
          int (*MARSHAL_PUBLIC)(CBB *, const PUBLIC_KEY *),
          int (*PARSE_PRIVATE)(PRIVATE_KEY *, CBS *),
          int (*MARSHAL_PRIVATE)(CBB *, const PRIVATE_KEY *),
          size_t CIPHERTEXT_BYTES,
          void (*ENCAP)(uint8_t *, uint8_t *, const PUBLIC_KEY *),
          int (*DECAP)(uint8_t *, const uint8_t *, size_t, const PRIVATE_KEY *)>
void BasicTest() {
  // This function makes several ML-KEM keys, which runs up against stack
  // limits. Heap-allocate them instead.

  uint8_t encoded_public_key[PUBLIC_KEY_BYTES];
  uint8_t seed[MLKEM_SEED_BYTES];
  auto priv = std::make_unique<PRIVATE_KEY>();
  GENERATE(encoded_public_key, seed, priv.get());

  {
    auto priv2 = std::make_unique<PRIVATE_KEY>();
    ASSERT_TRUE(FROM_SEED(priv2.get(), seed, sizeof(seed)));
    EXPECT_EQ(Bytes(Declassified(Marshal(MARSHAL_PRIVATE, priv.get()))),
              Bytes(Declassified(Marshal(MARSHAL_PRIVATE, priv2.get()))));
  }

  uint8_t first_two_bytes[2];
  OPENSSL_memcpy(first_two_bytes, encoded_public_key, sizeof(first_two_bytes));
  OPENSSL_memset(encoded_public_key, 0xff, sizeof(first_two_bytes));
  CBS encoded_public_key_cbs;
  CBS_init(&encoded_public_key_cbs, encoded_public_key,
           sizeof(encoded_public_key));
  auto pub = std::make_unique<PUBLIC_KEY>();
  // Parsing should fail because the first coefficient is >= kPrime;
  ASSERT_FALSE(PARSE_PUBLIC(pub.get(), &encoded_public_key_cbs));

  OPENSSL_memcpy(encoded_public_key, first_two_bytes, sizeof(first_two_bytes));
  CBS_init(&encoded_public_key_cbs, encoded_public_key,
           sizeof(encoded_public_key));
  ASSERT_TRUE(PARSE_PUBLIC(pub.get(), &encoded_public_key_cbs));
  EXPECT_EQ(CBS_len(&encoded_public_key_cbs), 0u);

  EXPECT_EQ(Bytes(encoded_public_key),
            Bytes(Marshal(MARSHAL_PUBLIC, pub.get())));

  auto pub2 = std::make_unique<PUBLIC_KEY>();
  PUBLIC_FROM_PRIVATE(pub2.get(), priv.get());
  EXPECT_EQ(Bytes(encoded_public_key),
            Bytes(Marshal(MARSHAL_PUBLIC, pub2.get())));

  std::vector<uint8_t> encoded_private_key(
      Marshal(MARSHAL_PRIVATE, priv.get()));
  EXPECT_EQ(encoded_private_key.size(), size_t{PRIVATE_KEY_BYTES});

  OPENSSL_memcpy(first_two_bytes, encoded_private_key.data(),
                 sizeof(first_two_bytes));
  OPENSSL_memset(encoded_private_key.data(), 0xff, sizeof(first_two_bytes));
  CBS cbs;
  CBS_init(&cbs, encoded_private_key.data(), encoded_private_key.size());
  auto priv2 = std::make_unique<PRIVATE_KEY>();
  // Parsing should fail because the first coefficient is >= kPrime.
  ASSERT_FALSE(PARSE_PRIVATE(priv2.get(), &cbs));

  OPENSSL_memcpy(encoded_private_key.data(), first_two_bytes,
                 sizeof(first_two_bytes));
  CBS_init(&cbs, encoded_private_key.data(), encoded_private_key.size());
  ASSERT_TRUE(PARSE_PRIVATE(priv2.get(), &cbs));
  EXPECT_EQ(Bytes(Declassified(encoded_private_key)),
            Bytes(Declassified(Marshal(MARSHAL_PRIVATE, priv2.get()))));

  uint8_t ciphertext[CIPHERTEXT_BYTES];
  uint8_t shared_secret1[MLKEM_SHARED_SECRET_BYTES];
  uint8_t shared_secret2[MLKEM_SHARED_SECRET_BYTES];
  ENCAP(ciphertext, shared_secret1, pub.get());
  ASSERT_TRUE(
      DECAP(shared_secret2, ciphertext, sizeof(ciphertext), priv.get()));
  EXPECT_EQ(Bytes(Declassified(shared_secret1)),
            Bytes(Declassified(shared_secret2)));
  ASSERT_TRUE(
      DECAP(shared_secret2, ciphertext, sizeof(ciphertext), priv2.get()));
  EXPECT_EQ(Bytes(Declassified(shared_secret1)),
            Bytes(Declassified(shared_secret2)));
}

TEST(MLKEMTest, Basic768) {
  BasicTest<MLKEM768_public_key, MLKEM768_PUBLIC_KEY_BYTES,
            MLKEM768_private_key, BCM_MLKEM768_PRIVATE_KEY_BYTES,
            MLKEM768_generate_key, MLKEM768_private_key_from_seed,
            MLKEM768_public_from_private, MLKEM768_parse_public_key,
            MLKEM768_marshal_public_key, wrapper_768_parse_private_key,
            wrapper_768_marshal_private_key, MLKEM768_CIPHERTEXT_BYTES,
            MLKEM768_encap, MLKEM768_decap>();
}

TEST(MLKEMTest, Basic1024) {
  BasicTest<MLKEM1024_public_key, MLKEM1024_PUBLIC_KEY_BYTES,
            MLKEM1024_private_key, BCM_MLKEM1024_PRIVATE_KEY_BYTES,
            MLKEM1024_generate_key, MLKEM1024_private_key_from_seed,
            MLKEM1024_public_from_private, MLKEM1024_parse_public_key,
            MLKEM1024_marshal_public_key, wrapper_1024_parse_private_key,
            wrapper_1024_marshal_private_key, MLKEM1024_CIPHERTEXT_BYTES,
            MLKEM1024_encap, MLKEM1024_decap>();
}

template <typename PUBLIC_KEY, size_t PUBLIC_KEY_BYTES, typename PRIVATE_KEY,
          int (*MARSHAL_PRIVATE)(CBB *, const PRIVATE_KEY *),
          void (*GENERATE)(uint8_t *, PRIVATE_KEY *, const uint8_t *)>
void MLKEMKeyGenFileTest(FileTest *t) {
  std::vector<uint8_t> expected_pub_key_bytes, seed, expected_priv_key_bytes;
  ASSERT_TRUE(t->GetBytes(&seed, "seed"));
  CONSTTIME_SECRET(seed.data(), seed.size());
  ASSERT_TRUE(t->GetBytes(&expected_pub_key_bytes, "public_key"));
  ASSERT_TRUE(t->GetBytes(&expected_priv_key_bytes, "private_key"));

  ASSERT_EQ(seed.size(), size_t{MLKEM_SEED_BYTES});

  std::vector<uint8_t> pub_key_bytes(PUBLIC_KEY_BYTES);
  auto priv = std::make_unique<PRIVATE_KEY>();
  GENERATE(pub_key_bytes.data(), priv.get(), seed.data());
  const std::vector<uint8_t> priv_key_bytes(
      Marshal(MARSHAL_PRIVATE, priv.get()));

  EXPECT_EQ(Bytes(pub_key_bytes), Bytes(expected_pub_key_bytes));
  EXPECT_EQ(Bytes(Declassified(priv_key_bytes)),
            Bytes(expected_priv_key_bytes));
}

TEST(MLKEMTest, KeyGen768TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem768_keygen_tests.txt",
      MLKEMKeyGenFileTest<MLKEM768_public_key, MLKEM768_PUBLIC_KEY_BYTES,
                          MLKEM768_private_key, wrapper_768_marshal_private_key,
                          wrapper_768_generate_key_external_seed>);
}

TEST(MLKEMTest, KeyGen1024TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem1024_keygen_tests.txt",
      MLKEMKeyGenFileTest<MLKEM1024_public_key, MLKEM1024_PUBLIC_KEY_BYTES,
                          MLKEM1024_private_key,
                          wrapper_1024_marshal_private_key,
                          wrapper_1024_generate_key_external_seed>);
}

template <typename PUBLIC_KEY, size_t PUBLIC_KEY_BYTES, typename PRIVATE_KEY,
          int (*MARSHAL_PRIVATE)(CBB *, const PRIVATE_KEY *),
          void (*GENERATE)(uint8_t *, PRIVATE_KEY *, const uint8_t *)>
void MLKEMNistKeyGenFileTest(FileTest *t) {
  std::vector<uint8_t> expected_pub_key_bytes, z, d, expected_priv_key_bytes;
  ASSERT_TRUE(t->GetBytes(&z, "z"));
  ASSERT_TRUE(t->GetBytes(&d, "d"));
  ASSERT_TRUE(t->GetBytes(&expected_pub_key_bytes, "ek"));
  ASSERT_TRUE(t->GetBytes(&expected_priv_key_bytes, "dk"));

  ASSERT_EQ(z.size(), size_t{MLKEM_SEED_BYTES} / 2);
  ASSERT_EQ(d.size(), size_t{MLKEM_SEED_BYTES} / 2);

  uint8_t seed[MLKEM_SEED_BYTES];
  OPENSSL_memcpy(&seed[0], d.data(), d.size());
  OPENSSL_memcpy(&seed[MLKEM_SEED_BYTES / 2], z.data(), z.size());
  std::vector<uint8_t> pub_key_bytes(PUBLIC_KEY_BYTES);
  auto priv = std::make_unique<PRIVATE_KEY>();
  GENERATE(pub_key_bytes.data(), priv.get(), seed);
  const std::vector<uint8_t> priv_key_bytes(
      Marshal(MARSHAL_PRIVATE, priv.get()));

  EXPECT_EQ(Bytes(pub_key_bytes), Bytes(expected_pub_key_bytes));
  EXPECT_EQ(Bytes(priv_key_bytes), Bytes(expected_priv_key_bytes));
}

TEST(MLKEMTest, NISTKeyGen768TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem768_nist_keygen_tests.txt",
      MLKEMNistKeyGenFileTest<MLKEM768_public_key, MLKEM768_PUBLIC_KEY_BYTES,
                              MLKEM768_private_key,
                              wrapper_768_marshal_private_key,
                              wrapper_768_generate_key_external_seed>);
}

TEST(MLKEMTest, NISTKeyGen1024TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem1024_nist_keygen_tests.txt",
      MLKEMNistKeyGenFileTest<MLKEM1024_public_key, MLKEM1024_PUBLIC_KEY_BYTES,
                              MLKEM1024_private_key,
                              wrapper_1024_marshal_private_key,
                              wrapper_1024_generate_key_external_seed>);
}

template <typename PUBLIC_KEY, size_t PUBLIC_KEY_BYTES,
          int (*PARSE_PUBLIC)(PUBLIC_KEY *, CBS *), size_t CIPHERTEXT_BYTES,
          void (*ENCAP)(uint8_t *, uint8_t *, const PUBLIC_KEY *,
                        const uint8_t *)>
void MLKEMEncapFileTest(FileTest *t) {
  std::vector<uint8_t> pub_key_bytes, entropy, expected_ciphertext,
      expected_shared_secret;
  ASSERT_TRUE(t->GetBytes(&entropy, "entropy"));
  CONSTTIME_SECRET(entropy.data(), entropy.size());
  ASSERT_TRUE(t->GetBytes(&pub_key_bytes, "public_key"));
  ASSERT_TRUE(t->GetBytes(&expected_ciphertext, "ciphertext"));
  ASSERT_TRUE(t->GetBytes(&expected_shared_secret, "shared_secret"));
  std::string result;
  ASSERT_TRUE(t->GetAttribute(&result, "result"));

  PUBLIC_KEY pub_key;
  CBS pub_key_cbs;
  CBS_init(&pub_key_cbs, pub_key_bytes.data(), pub_key_bytes.size());
  const int parse_ok = PARSE_PUBLIC(&pub_key, &pub_key_cbs);
  ASSERT_EQ(parse_ok, result == "pass");
  if (!parse_ok) {
    return;
  }

  uint8_t ciphertext[CIPHERTEXT_BYTES];
  uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
  ENCAP(ciphertext, shared_secret, &pub_key, entropy.data());

  ASSERT_EQ(Bytes(expected_ciphertext), Bytes(ciphertext));
  ASSERT_EQ(Bytes(expected_shared_secret), Bytes(Declassified(shared_secret)));
}

TEST(MLKEMTest, Encap768TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem768_encap_tests.txt",
      MLKEMEncapFileTest<MLKEM768_public_key, MLKEM768_PUBLIC_KEY_BYTES,
                         MLKEM768_parse_public_key, MLKEM768_CIPHERTEXT_BYTES,
                         wrapper_768_encap_external_entropy>);
}

TEST(MLKEMTest, Encap1024TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem1024_encap_tests.txt",
      MLKEMEncapFileTest<MLKEM1024_public_key, MLKEM1024_PUBLIC_KEY_BYTES,
                         MLKEM1024_parse_public_key, MLKEM1024_CIPHERTEXT_BYTES,
                         wrapper_1024_encap_external_entropy>);
}

template <typename PRIVATE_KEY, size_t PRIVATE_KEY_BYTES,
          int (*PARSE_PRIVATE)(PRIVATE_KEY *, CBS *), size_t CIPHERTEXT_BYTES,
          int (*DECAP)(uint8_t *, const uint8_t *, size_t, const PRIVATE_KEY *)>
void MLKEMDecapFileTest(FileTest *t) {
  std::vector<uint8_t> priv_key_bytes, ciphertext, expected_shared_secret;
  ASSERT_TRUE(t->GetBytes(&priv_key_bytes, "private_key"));
  ASSERT_TRUE(t->GetBytes(&ciphertext, "ciphertext"));
  ASSERT_TRUE(t->GetBytes(&expected_shared_secret, "shared_secret"));
  std::string result;
  ASSERT_TRUE(t->GetAttribute(&result, "result"));

  PRIVATE_KEY priv_key;
  CBS priv_key_cbs;
  CBS_init(&priv_key_cbs, priv_key_bytes.data(), priv_key_bytes.size());
  const int parse_ok = PARSE_PRIVATE(&priv_key, &priv_key_cbs);
  if (!parse_ok) {
    ASSERT_NE(result, "pass");
    return;
  }

  uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
  const int decap_ok =
      DECAP(shared_secret, ciphertext.data(), ciphertext.size(), &priv_key);
  if (!decap_ok) {
    ASSERT_NE(result, "pass");
    return;
  }

  ASSERT_EQ(Bytes(expected_shared_secret), Bytes(shared_secret));
}

TEST(MLKEMTest, Decap768TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem768_decap_tests.txt",
      MLKEMDecapFileTest<MLKEM768_private_key, BCM_MLKEM768_PRIVATE_KEY_BYTES,
                         wrapper_768_parse_private_key,
                         MLKEM768_CIPHERTEXT_BYTES, MLKEM768_decap>);
}

TEST(MLKEMTest, Decap1024TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem1024_decap_tests.txt",
      MLKEMDecapFileTest<MLKEM1024_private_key, BCM_MLKEM1024_PRIVATE_KEY_BYTES,
                         wrapper_1024_parse_private_key,
                         MLKEM1024_CIPHERTEXT_BYTES, MLKEM1024_decap>);
}

template <typename PRIVATE_KEY, int (*PARSE_PRIVATE)(PRIVATE_KEY *, CBS *),
          int (*DECAP)(uint8_t *, const uint8_t *, size_t, const PRIVATE_KEY *)>
void MLKEMNistDecapFileTest(FileTest *t) {
  std::vector<uint8_t> ciphertext, expected_shared_secret, private_key_bytes;
  ASSERT_TRUE(t->GetBytes(&ciphertext, "c"));
  ASSERT_TRUE(t->GetBytes(&expected_shared_secret, "k"));
  ASSERT_TRUE(t->GetInstructionBytes(&private_key_bytes, "dk"));

  PRIVATE_KEY priv;
  CBS private_key_cbs;
  CBS_init(&private_key_cbs, private_key_bytes.data(),
           private_key_bytes.size());
  ASSERT_TRUE(PARSE_PRIVATE(&priv, &private_key_cbs));

  uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
  ASSERT_TRUE(
      DECAP(shared_secret, ciphertext.data(), ciphertext.size(), &priv));

  ASSERT_EQ(Bytes(shared_secret), Bytes(expected_shared_secret));
}

TEST(MLKEMTest, NistDecap768TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem768_nist_decap_tests.txt",
      MLKEMNistDecapFileTest<MLKEM768_private_key,
                             wrapper_768_parse_private_key, MLKEM768_decap>);
}

TEST(MLKEMTest, NistDecap1024TestVectors) {
  FileTestGTest(
      "crypto/mlkem/mlkem1024_nist_decap_tests.txt",
      MLKEMNistDecapFileTest<MLKEM1024_private_key,
                             wrapper_1024_parse_private_key, MLKEM1024_decap>);
}

template <
    typename PUBLIC_KEY, size_t PUBLIC_KEY_BYTES, typename PRIVATE_KEY,
    size_t PRIVATE_KEY_BYTES,
    void (*GENERATE)(uint8_t *, PRIVATE_KEY *, const uint8_t *),
    void (*TO_PUBLIC)(PUBLIC_KEY *, const PRIVATE_KEY *),
    int (*MARSHAL_PRIVATE)(CBB *, const PRIVATE_KEY *), size_t CIPHERTEXT_BYTES,
    void (*ENCAP)(uint8_t *, uint8_t *, const PUBLIC_KEY *, const uint8_t *),
    int (*DECAP)(uint8_t *, const uint8_t *, size_t, const PRIVATE_KEY *)>
void IteratedTest(uint8_t out[32]) {
  BORINGSSL_keccak_st generate_st;
  BORINGSSL_keccak_init(&generate_st, boringssl_shake128);
  BORINGSSL_keccak_st results_st;
  BORINGSSL_keccak_init(&results_st, boringssl_shake128);

  auto priv = std::make_unique<PRIVATE_KEY>();
  auto pub = std::make_unique<PUBLIC_KEY>();
  for (int i = 0; i < 10000; i++) {
    uint8_t seed[MLKEM_SEED_BYTES];
    BORINGSSL_keccak_squeeze(&generate_st, seed, sizeof(seed));
    uint8_t encoded_pub[PUBLIC_KEY_BYTES];
    GENERATE(encoded_pub, priv.get(), seed);
    TO_PUBLIC(pub.get(), priv.get());

    BORINGSSL_keccak_absorb(&results_st, encoded_pub, sizeof(encoded_pub));
    const std::vector<uint8_t> encoded_priv(
        Marshal(MARSHAL_PRIVATE, priv.get()));
    BORINGSSL_keccak_absorb(&results_st, encoded_priv.data(),
                            encoded_priv.size());

    uint8_t encap_entropy[BCM_MLKEM_ENCAP_ENTROPY];
    BORINGSSL_keccak_squeeze(&generate_st, encap_entropy,
                             sizeof(encap_entropy));
    uint8_t ciphertext[CIPHERTEXT_BYTES];
    uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
    ENCAP(ciphertext, shared_secret, pub.get(), encap_entropy);

    BORINGSSL_keccak_absorb(&results_st, ciphertext, sizeof(ciphertext));
    BORINGSSL_keccak_absorb(&results_st, shared_secret, sizeof(shared_secret));

    uint8_t invalid_ciphertext[CIPHERTEXT_BYTES];
    BORINGSSL_keccak_squeeze(&generate_st, invalid_ciphertext,
                             sizeof(invalid_ciphertext));
    ASSERT_TRUE(DECAP(shared_secret, invalid_ciphertext,
                      sizeof(invalid_ciphertext), priv.get()));

    BORINGSSL_keccak_absorb(&results_st, shared_secret, sizeof(shared_secret));
  }

  BORINGSSL_keccak_squeeze(&results_st, out, 32);
}

TEST(MLKEMTest, Iterate768) {
  // The structure of this test is taken from
  // https://github.com/C2SP/CCTV/blob/main/ML-KEM/README.md?ref=words.filippo.io#accumulated-pq-crystals-vectors
  // but the final value has been updated to reflect the change from Kyber to
  // ML-KEM.
  uint8_t result[32];
  IteratedTest<MLKEM768_public_key, MLKEM768_PUBLIC_KEY_BYTES,
               MLKEM768_private_key, BCM_MLKEM768_PRIVATE_KEY_BYTES,
               wrapper_768_generate_key_external_seed,
               MLKEM768_public_from_private, wrapper_768_marshal_private_key,
               MLKEM768_CIPHERTEXT_BYTES, wrapper_768_encap_external_entropy,
               MLKEM768_decap>(result);

  const uint8_t kExpected[32] = {
      0xf9, 0x59, 0xd1, 0x8d, 0x3d, 0x11, 0x80, 0x12, 0x14, 0x33, 0xbf,
      0x0e, 0x05, 0xf1, 0x1e, 0x79, 0x08, 0xcf, 0x9d, 0x03, 0xed, 0xc1,
      0x50, 0xb2, 0xb0, 0x7c, 0xb9, 0x0b, 0xef, 0x5b, 0xc1, 0xc1};
  EXPECT_EQ(Bytes(result), Bytes(kExpected));
}


TEST(MLKEMTest, Iterate1024) {
  // The structure of this test is taken from
  // https://github.com/C2SP/CCTV/blob/main/ML-KEM/README.md?ref=words.filippo.io#accumulated-pq-crystals-vectors
  // but the final value has been updated to reflect the change from Kyber to
  // ML-KEM.
  uint8_t result[32];
  IteratedTest<MLKEM1024_public_key, MLKEM1024_PUBLIC_KEY_BYTES,
               MLKEM1024_private_key, BCM_MLKEM1024_PRIVATE_KEY_BYTES,
               wrapper_1024_generate_key_external_seed,
               MLKEM1024_public_from_private, wrapper_1024_marshal_private_key,
               MLKEM1024_CIPHERTEXT_BYTES, wrapper_1024_encap_external_entropy,
               MLKEM1024_decap>(result);

  const uint8_t kExpected[32] = {
      0xe3, 0xbf, 0x82, 0xb0, 0x13, 0x30, 0x7b, 0x2e, 0x9d, 0x47, 0xdd,
      0xe7, 0x91, 0xff, 0x6d, 0xfc, 0x82, 0xe6, 0x94, 0xe6, 0x38, 0x24,
      0x04, 0xab, 0xdb, 0x94, 0x8b, 0x90, 0x8b, 0x75, 0xba, 0xd5};
  EXPECT_EQ(Bytes(result), Bytes(kExpected));
}

TEST(MLKEMTest, Self) { ASSERT_TRUE(boringssl_self_test_mlkem()); }

TEST(MLKEMTest, PWCT) {
  auto pub768 = std::make_unique<uint8_t[]>(MLKEM768_PUBLIC_KEY_BYTES);
  auto priv768 = std::make_unique<MLKEM768_private_key>();
  ASSERT_EQ(
      BCM_mlkem768_generate_key_fips(pub768.get(), nullptr, priv768.get()),
      bcm_status::approved);

  auto pub1024 = std::make_unique<uint8_t[]>(MLKEM1024_PUBLIC_KEY_BYTES);
  auto priv1024 = std::make_unique<MLKEM1024_private_key>();
  ASSERT_EQ(
      BCM_mlkem1024_generate_key_fips(pub1024.get(), nullptr, priv1024.get()),
      bcm_status::approved);
}

TEST(MLKEMTest, NullptrArgumentsToCreate) {
  // For FIPS reasons, this should fail rather than crash.
  ASSERT_EQ(BCM_mlkem768_generate_key_fips(nullptr, nullptr, nullptr),
            bcm_status::failure);
  ASSERT_EQ(BCM_mlkem1024_generate_key_fips(nullptr, nullptr, nullptr),
            bcm_status::failure);
}

}  // namespace
