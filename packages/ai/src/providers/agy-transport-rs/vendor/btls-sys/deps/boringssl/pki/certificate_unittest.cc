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

#include <optional>
#include <string>
#include <string_view>

#include <openssl/pki/certificate.h>
#include <gmock/gmock.h>

#include "string_util.h"
#include "test_helpers.h"

TEST(CertificateTest, FromPEM) {
  std::string diagnostic;
  std::unique_ptr<bssl::Certificate> cert(
      bssl::Certificate::FromPEM("nonsense", &diagnostic));
  EXPECT_FALSE(cert);

  cert = bssl::Certificate::FromPEM(bssl::ReadTestFileToString(
      "testdata/verify_unittest/self-issued.pem"), &diagnostic);
  EXPECT_TRUE(cert);
}

TEST(CertificateTest, IsSelfIssued) {
  std::string diagnostic;
  const std::string leaf =
      bssl::ReadTestFileToString("testdata/verify_unittest/google-leaf.der");
  std::unique_ptr<bssl::Certificate> leaf_cert(
      bssl::Certificate::FromDER(bssl::StringAsBytes(leaf), &diagnostic));
  EXPECT_TRUE(leaf_cert);
  EXPECT_FALSE(leaf_cert->IsSelfIssued());

  const std::string self_issued =
      bssl::ReadTestFileToString("testdata/verify_unittest/self-issued.pem");
  std::unique_ptr<bssl::Certificate> self_issued_cert(
      bssl::Certificate::FromPEM(self_issued, &diagnostic));
  EXPECT_TRUE(self_issued_cert);
  EXPECT_TRUE(self_issued_cert->IsSelfIssued());
}

TEST(CertificateTest, Validity) {
  std::string diagnostic;
  const std::string leaf =
      bssl::ReadTestFileToString("testdata/verify_unittest/google-leaf.der");
  std::unique_ptr<bssl::Certificate> cert(
      bssl::Certificate::FromDER(bssl::StringAsBytes(leaf), &diagnostic));
  EXPECT_TRUE(cert);

  bssl::Certificate::Validity validity = cert->GetValidity();
  EXPECT_EQ(validity.not_before, 1498644466);
  EXPECT_EQ(validity.not_after, 1505899620);
}

TEST(CertificateTest, SerialNumber) {
  std::string diagnostic;
  const std::string leaf =
      bssl::ReadTestFileToString("testdata/verify_unittest/google-leaf.der");
  std::unique_ptr<bssl::Certificate> cert(
      bssl::Certificate::FromDER(bssl::StringAsBytes(leaf), &diagnostic));
  EXPECT_TRUE(cert);

  EXPECT_EQ(bssl::string_util::HexEncode(cert->GetSerialNumber()),
            "0118F044A8F31892");
}
