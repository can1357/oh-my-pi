// Copyright 2017 The Chromium Authors
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

#include "simple_path_builder_delegate.h"

#include <memory>
#include <set>

#include <gtest/gtest.h>

#include <openssl/nid.h>
#include <openssl/span.h>

#include "cert_errors.h"
#include "input.h"
#include "parse_values.h"
#include "parser.h"
#include "signature_algorithm.h"
#include "test_helpers.h"
#include "verify_signed_data.h"

BSSL_NAMESPACE_BEGIN

namespace {

// Reads the public key and algorithm from the test data at |file_name|.
void ReadTestCase(const char *file_name,
                  SignatureAlgorithm *signature_algorithm,
                  bssl::UniquePtr<EVP_PKEY> *public_key) {
  std::string path =
      std::string("testdata/verify_signed_data_unittest/") + file_name;

  std::string public_key_str;
  std::string algorithm_str;

  const PemBlockMapping mappings[] = {
      {"PUBLIC KEY", &public_key_str},
      {"ALGORITHM", &algorithm_str},
  };

  ASSERT_TRUE(ReadTestDataFromPemFile(path, mappings));

  std::optional<SignatureAlgorithm> sigalg_opt =
      ParseSignatureAlgorithm(StringAsBytes(algorithm_str));
  ASSERT_TRUE(sigalg_opt);
  *signature_algorithm = *sigalg_opt;

  ASSERT_TRUE(ParsePublicKey(StringAsBytes(public_key_str), public_key));
}

class SimplePathBuilderDelegate1024SuccessTest
    : public ::testing::TestWithParam<const char *> {};

const char *kSuccess1024Filenames[] = {
    "rsa-pkcs1-sha1.pem",          "rsa-pkcs1-sha256.pem",
    "rsa2048-pkcs1-sha512.pem",    "ecdsa-secp384r1-sha256.pem",
    "ecdsa-prime256v1-sha512.pem", "rsa-pss-sha256.pem",
    "ecdsa-secp384r1-sha256.pem",  "ecdsa-prime256v1-sha512.pem",
};

INSTANTIATE_TEST_SUITE_P(All, SimplePathBuilderDelegate1024SuccessTest,
                         ::testing::ValuesIn(kSuccess1024Filenames));

TEST_P(SimplePathBuilderDelegate1024SuccessTest, IsAcceptableSignatureAndKey) {
  SignatureAlgorithm signature_algorithm{};
  bssl::UniquePtr<EVP_PKEY> public_key;
  ASSERT_NO_FATAL_FAILURE(
      ReadTestCase(GetParam(), &signature_algorithm, &public_key));
  ASSERT_TRUE(public_key);

  CertErrors errors;
  SimplePathBuilderDelegate delegate(
      1024, SimplePathBuilderDelegate::DigestPolicy::kWeakAllowSha1);

  EXPECT_TRUE(
      delegate.IsSignatureAlgorithmAcceptable(signature_algorithm, &errors));

  EXPECT_TRUE(delegate.IsPublicKeyAcceptable(public_key.get(), &errors));
}

class SimplePathBuilderDelegate2048FailTest
    : public ::testing::TestWithParam<const char *> {};

const char *kFail2048Filenames[] = {"rsa-pkcs1-sha1.pem",
                                    "rsa-pkcs1-sha256.pem"};

INSTANTIATE_TEST_SUITE_P(All, SimplePathBuilderDelegate2048FailTest,
                         ::testing::ValuesIn(kFail2048Filenames));

TEST_P(SimplePathBuilderDelegate2048FailTest, RsaKeySmallerThan2048) {
  SignatureAlgorithm signature_algorithm{};
  bssl::UniquePtr<EVP_PKEY> public_key;
  ASSERT_NO_FATAL_FAILURE(
      ReadTestCase(GetParam(), &signature_algorithm, &public_key));
  ASSERT_TRUE(public_key);

  CertErrors errors;
  SimplePathBuilderDelegate delegate(
      2048, SimplePathBuilderDelegate::DigestPolicy::kWeakAllowSha1);

  EXPECT_TRUE(
      delegate.IsSignatureAlgorithmAcceptable(signature_algorithm, &errors));

  EXPECT_FALSE(delegate.IsPublicKeyAcceptable(public_key.get(), &errors));
}

}  // namespace

BSSL_NAMESPACE_END
