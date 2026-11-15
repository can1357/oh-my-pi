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

#include <string.h>

#include <optional>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>
#include <openssl/pki/verify.h>
#include <openssl/pki/verify_error.h>
#include <openssl/sha2.h>

#include "test_helpers.h"

BSSL_NAMESPACE_BEGIN

static std::unique_ptr<VerifyTrustStore> MozillaRootStore() {
  std::string diagnostic;
  return VerifyTrustStore::FromDER(
             bssl::ReadTestFileToString(
                 "testdata/verify_unittest/mozilla_roots.der"),
             &diagnostic);
}

using ::testing::UnorderedElementsAre;

static std::string GetTestdata(std::string_view filename) {
  return bssl::ReadTestFileToString("testdata/verify_unittest/" +
                                    std::string(filename));
}

TEST(VerifyTest, GoogleChain) {
  const std::string leaf = GetTestdata("google-leaf.der");
  const std::string intermediate1 = GetTestdata("google-intermediate1.der");
  const std::string intermediate2 = GetTestdata("google-intermediate2.der");
  CertificateVerifyOptions opts;
  opts.leaf_cert = leaf;
  opts.intermediates = {intermediate1, intermediate2};
  opts.time = 1499727444;
  std::unique_ptr<VerifyTrustStore> roots = MozillaRootStore();
  opts.trust_store = roots.get();

  VerifyError error;
  ASSERT_TRUE(CertificateVerify(opts, &error)) << error.DiagnosticString();

  opts.intermediates = {};
  EXPECT_FALSE(CertificateVerify(opts, &error));
  ASSERT_EQ(error.Code(), VerifyError::StatusCode::PATH_NOT_FOUND)
      << error.DiagnosticString();
}


TEST(VerifyTest, ExtraIntermediates) {
  const std::string leaf = GetTestdata("google-leaf.der");
  const std::string intermediate1 = GetTestdata("google-intermediate1.der");
  const std::string intermediate2 = GetTestdata("google-intermediate2.der");

  CertificateVerifyOptions opts;
  opts.leaf_cert = leaf;
  std::string diagnostic;
  const auto cert_pool_status = CertPool::FromCerts(
      {
          intermediate1,
          intermediate2,
      },
      &diagnostic);
  ASSERT_TRUE(cert_pool_status) << diagnostic;
  opts.extra_intermediates = cert_pool_status.get();
  opts.time = 1499727444;
  std::unique_ptr<VerifyTrustStore> roots = MozillaRootStore();
  opts.trust_store = roots.get();

  VerifyError error;
  ASSERT_TRUE(CertificateVerify(opts, &error)) << error.DiagnosticString();
}

TEST(VerifyTest, AllPaths) {
  const std::string leaf = GetTestdata("lencr-leaf.der");
  const std::string intermediate1 = GetTestdata("lencr-intermediate-r3.der");
  const std::string intermediate2 =
      GetTestdata("lencr-root-x1-cross-signed.der");
  const std::string root1 = GetTestdata("lencr-root-x1.der");
  const std::string root2 = GetTestdata("lencr-root-dst-x3.der");

  std::vector<std::string> expected_path1 = {leaf, intermediate1, root1};
  std::vector<std::string> expected_path2 = {leaf, intermediate1, intermediate2,
                                             root2};

  CertificateVerifyOptions opts;
  opts.leaf_cert = leaf;
  opts.intermediates = {intermediate1, intermediate2};
  opts.time = 1699404611;
  std::unique_ptr<VerifyTrustStore> roots = MozillaRootStore();
  opts.trust_store = roots.get();

  auto paths = CertificateVerifyAllPaths(opts);
  ASSERT_TRUE(paths);
  EXPECT_EQ(2U, paths.value().size());
  EXPECT_THAT(paths.value(),
              UnorderedElementsAre(expected_path1, expected_path2));
}

TEST(VerifyTest, DepthLimit) {
  const std::string leaf = GetTestdata("google-leaf.der");
  const std::string intermediate1 = GetTestdata("google-intermediate1.der");
  const std::string intermediate2 = GetTestdata("google-intermediate2.der");
  CertificateVerifyOptions opts;
  opts.leaf_cert = leaf;
  opts.intermediates = {intermediate1, intermediate2};
  opts.time = 1499727444;
  // Set the |max_path_building_depth| explicitly to test the non-default case.
  // Depth of 5 is enough to successfully find a path.
  opts.max_path_building_depth = 5;
  std::unique_ptr<VerifyTrustStore> roots = MozillaRootStore();
  opts.trust_store = roots.get();

  VerifyError error;
  ASSERT_TRUE(CertificateVerify(opts, &error)) << error.DiagnosticString();

  // Depth of 2 is not enough to find a path.
  opts.max_path_building_depth = 2;
  EXPECT_FALSE(CertificateVerify(opts, &error));
  ASSERT_EQ(error.Code(), VerifyError::StatusCode::PATH_DEPTH_LIMIT_REACHED)
      << error.DiagnosticString();
}

BSSL_NAMESPACE_END
