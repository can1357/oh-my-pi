// Copyright 2015 The Chromium Authors
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

#include "verify_signed_data.h"

#include <memory>
#include <optional>
#include <set>

#include <gtest/gtest.h>

#include <openssl/span.h>

#include "cert_errors.h"
#include "input.h"
#include "mock_signature_verify_cache.h"
#include "parse_values.h"
#include "parser.h"
#include "signature_algorithm.h"
#include "test_helpers.h"

BSSL_NAMESPACE_BEGIN

namespace {

enum VerifyResult {
  SUCCESS,
  FAILURE,
};

// Reads test data from |file_name| and runs VerifySignedData() over its
// inputs.
//
// If expected_result was SUCCESS then the test will only succeed if
// VerifySignedData() returns true.
//
// If expected_result was FAILURE then the test will only succeed if
// VerifySignedData() returns false.
void RunTestCase(VerifyResult expected_result, const char *file_name,
                 SignatureVerifyCache *cache) {
  std::string path =
      std::string("testdata/verify_signed_data_unittest/") + file_name;

  std::string public_key;
  std::string algorithm;
  std::string signed_data;
  std::string signature_value;

  const PemBlockMapping mappings[] = {
      {"PUBLIC KEY", &public_key},
      {"ALGORITHM", &algorithm},
      {"DATA", &signed_data},
      {"SIGNATURE", &signature_value},
  };

  ASSERT_TRUE(ReadTestDataFromPemFile(path, mappings));

  std::optional<SignatureAlgorithm> signature_algorithm =
      ParseSignatureAlgorithm(StringAsBytes(algorithm));
  ASSERT_TRUE(signature_algorithm);

  der::Parser signature_value_parser(StringAsBytes(signature_value));
  std::optional<der::BitString> signature_value_bit_string =
      signature_value_parser.ReadBitString();
  ASSERT_TRUE(signature_value_bit_string.has_value())
      << "The signature value is not a valid BIT STRING";

  bool expected_result_bool = expected_result == SUCCESS;

  bool result = VerifySignedData(
      *signature_algorithm, StringAsBytes(signed_data),
      signature_value_bit_string.value(), StringAsBytes(public_key), cache);

  EXPECT_EQ(expected_result_bool, result);
}

void RunTestCase(VerifyResult expected_result, const char *file_name) {
  RunTestCase(expected_result, file_name, /*cache=*/nullptr);
}

// Read the descriptions in the test files themselves for details on what is
// being tested.

TEST(VerifySignedDataTest, RsaPkcs1Sha1) {
  RunTestCase(SUCCESS, "rsa-pkcs1-sha1.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha256) {
  RunTestCase(SUCCESS, "rsa-pkcs1-sha256.pem");
}

TEST(VerifySignedDataTest, Rsa2048Pkcs1Sha512) {
  RunTestCase(SUCCESS, "rsa2048-pkcs1-sha512.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha256KeyEncodedBer) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha256-key-encoded-ber.pem");
}

TEST(VerifySignedDataTest, EcdsaSecp384r1Sha256) {
  RunTestCase(SUCCESS, "ecdsa-secp384r1-sha256.pem");
}

TEST(VerifySignedDataTest, EcdsaPrime256v1Sha512) {
  RunTestCase(SUCCESS, "ecdsa-prime256v1-sha512.pem");
}

TEST(VerifySignedDataTest, RsaPssSha256) {
  RunTestCase(SUCCESS, "rsa-pss-sha256.pem");
}

TEST(VerifySignedDataTest, RsaPssSha256WrongSalt) {
  RunTestCase(FAILURE, "rsa-pss-sha256-wrong-salt.pem");
}

TEST(VerifySignedDataTest, EcdsaSecp384r1Sha256CorruptedData) {
  RunTestCase(FAILURE, "ecdsa-secp384r1-sha256-corrupted-data.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha1WrongAlgorithm) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha1-wrong-algorithm.pem");
}

TEST(VerifySignedDataTest, EcdsaPrime256v1Sha512WrongSignatureFormat) {
  RunTestCase(FAILURE, "ecdsa-prime256v1-sha512-wrong-signature-format.pem");
}

TEST(VerifySignedDataTest, EcdsaUsingRsaKey) {
  RunTestCase(FAILURE, "ecdsa-using-rsa-key.pem");
}

TEST(VerifySignedDataTest, RsaUsingEcKey) {
  RunTestCase(FAILURE, "rsa-using-ec-key.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha1BadKeyDerNull) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha1-bad-key-der-null.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha1BadKeyDerLength) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha1-bad-key-der-length.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha256UsingEcdsaAlgorithm) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha256-using-ecdsa-algorithm.pem");
}

TEST(VerifySignedDataTest, EcdsaPrime256v1Sha512UsingRsaAlgorithm) {
  RunTestCase(FAILURE, "ecdsa-prime256v1-sha512-using-rsa-algorithm.pem");
}

TEST(VerifySignedDataTest, EcdsaPrime256v1Sha512UsingEcdhKey) {
  RunTestCase(FAILURE, "ecdsa-prime256v1-sha512-using-ecdh-key.pem");
}

TEST(VerifySignedDataTest, EcdsaPrime256v1Sha512UsingEcmqvKey) {
  RunTestCase(FAILURE, "ecdsa-prime256v1-sha512-using-ecmqv-key.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha1KeyParamsAbsent) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha1-key-params-absent.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha1UsingPssKeyNoParams) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha1-using-pss-key-no-params.pem");
}

TEST(VerifySignedDataTest, RsaPssSha256UsingPssKeyWithParams) {
  // We do not support RSA-PSS SPKIs.
  RunTestCase(FAILURE, "rsa-pss-sha256-using-pss-key-with-params.pem");
}

TEST(VerifySignedDataTest, EcdsaPrime256v1Sha512SpkiParamsNull) {
  RunTestCase(FAILURE, "ecdsa-prime256v1-sha512-spki-params-null.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha256UsingIdEaRsa) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha256-using-id-ea-rsa.pem");
}

TEST(VerifySignedDataTest, RsaPkcs1Sha256SpkiNonNullParams) {
  RunTestCase(FAILURE, "rsa-pkcs1-sha256-spki-non-null-params.pem");
}

TEST(VerifySignedDataTest, EcdsaPrime256v1Sha512UnusedBitsSignature) {
  RunTestCase(FAILURE, "ecdsa-prime256v1-sha512-unused-bits-signature.pem");
}

TEST(VerifySignedDataTest, Ecdsa384) {
  // Using the regular policy both secp384r1 and secp256r1 should be accepted.
  RunTestCase(SUCCESS, "ecdsa-secp384r1-sha256.pem");
  RunTestCase(SUCCESS, "ecdsa-prime256v1-sha512.pem");
}

TEST(VerifySignedDataTestWithCache, TestVerifyCache) {
  MockSignatureVerifyCache verify_cache;
  // Trivially, with no cache, all stats should be 0.
  RunTestCase(SUCCESS, "rsa-pss-sha256.pem", /*cache=*/nullptr);
  EXPECT_EQ(verify_cache.CacheHits(), 0U);
  EXPECT_EQ(verify_cache.CacheMisses(), 0U);
  EXPECT_EQ(verify_cache.CacheStores(), 0U);
  // Use the cache, with a successful verification should see a miss and a
  // store.
  RunTestCase(SUCCESS, "rsa-pss-sha256.pem", &verify_cache);
  EXPECT_EQ(verify_cache.CacheHits(), 0U);
  EXPECT_EQ(verify_cache.CacheMisses(), 1U);
  EXPECT_EQ(verify_cache.CacheStores(), 1U);
  // Repeating the previous successful verification should show cache hits.
  RunTestCase(SUCCESS, "rsa-pss-sha256.pem", &verify_cache);
  RunTestCase(SUCCESS, "rsa-pss-sha256.pem", &verify_cache);
  RunTestCase(SUCCESS, "rsa-pss-sha256.pem", &verify_cache);
  EXPECT_EQ(verify_cache.CacheHits(), 3U);
  EXPECT_EQ(verify_cache.CacheMisses(), 1U);
  EXPECT_EQ(verify_cache.CacheStores(), 1U);
  // Failures which are not due to a failed signature check should have no
  // effect as they must not be cached.
  RunTestCase(FAILURE, "ecdsa-prime256v1-sha512-using-ecdh-key.pem",
              &verify_cache);
  EXPECT_EQ(verify_cache.CacheHits(), 3U);
  EXPECT_EQ(verify_cache.CacheMisses(), 1U);
  EXPECT_EQ(verify_cache.CacheStores(), 1U);
  // Failures which are due to a failed signature check should see a miss and a
  // store.
  RunTestCase(FAILURE, "ecdsa-secp384r1-sha256-corrupted-data.pem",
              &verify_cache);
  EXPECT_EQ(verify_cache.CacheHits(), 3U);
  EXPECT_EQ(verify_cache.CacheMisses(), 2U);
  EXPECT_EQ(verify_cache.CacheStores(), 2U);
  // Repeating the previous failed verification should show cache hits.
  RunTestCase(FAILURE, "ecdsa-secp384r1-sha256-corrupted-data.pem",
              &verify_cache);
  RunTestCase(FAILURE, "ecdsa-secp384r1-sha256-corrupted-data.pem",
              &verify_cache);
  RunTestCase(FAILURE, "ecdsa-secp384r1-sha256-corrupted-data.pem",
              &verify_cache);
  EXPECT_EQ(verify_cache.CacheHits(), 6U);
  EXPECT_EQ(verify_cache.CacheMisses(), 2U);
  EXPECT_EQ(verify_cache.CacheStores(), 2U);
}

}  // namespace

BSSL_NAMESPACE_END
