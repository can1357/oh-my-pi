// Copyright 2016 The Chromium Authors
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

#include "ocsp.h"

#include <gtest/gtest.h>

#include <openssl/base64.h>
#include <openssl/pool.h>
#include <openssl/span.h>

#include "encode_values.h"
#include "string_util.h"
#include "test_helpers.h"

BSSL_NAMESPACE_BEGIN

namespace {

constexpr int64_t kOCSPAgeOneWeek = 7 * 24 * 60 * 60;

std::string GetFilePath(const std::string &file_name) {
  return std::string("testdata/ocsp_unittest/") + file_name;
}

std::shared_ptr<const ParsedCertificate> ParseCertificate(
    std::string_view data) {
  CertErrors errors;
  return ParsedCertificate::Create(
      bssl::UniquePtr<CRYPTO_BUFFER>(
          CRYPTO_BUFFER_new(reinterpret_cast<const uint8_t *>(data.data()),
                            data.size(), nullptr)),
      {}, &errors);
}

struct TestParams {
  const char *file_name;
  OCSPRevocationStatus expected_revocation_status;
  OCSPVerifyResult::ResponseStatus expected_response_status;
};

class CheckOCSPTest : public ::testing::TestWithParam<TestParams> {};

const TestParams kTestParams[] = {
    {"good_response.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"good_response_sha256.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"no_response.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::NO_MATCHING_RESPONSE},

    {"malformed_request.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::ERROR_RESPONSE},

    {"bad_status.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::PARSE_RESPONSE_ERROR},

    {"bad_ocsp_type.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::PARSE_RESPONSE_ERROR},

    {"bad_signature.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::PROVIDED},

    {"ocsp_sign_direct.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"ocsp_sign_indirect.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"ocsp_sign_indirect_missing.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::PROVIDED},

    {"ocsp_sign_bad_indirect.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::PROVIDED},

    {"ocsp_extra_certs.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"has_version.pem", OCSPRevocationStatus::GOOD, OCSPVerifyResult::PROVIDED},

    {"responder_name.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"responder_id.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"has_extension.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"good_response_next_update.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"revoke_response.pem", OCSPRevocationStatus::REVOKED,
     OCSPVerifyResult::PROVIDED},

    {"revoke_response_reason.pem", OCSPRevocationStatus::REVOKED,
     OCSPVerifyResult::PROVIDED},

    {"unknown_response.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::PROVIDED},

    {"multiple_response.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::PROVIDED},

    {"other_response.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::NO_MATCHING_RESPONSE},

    {"has_single_extension.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"has_critical_single_extension.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::UNHANDLED_CRITICAL_EXTENSION},

    {"has_critical_response_extension.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::UNHANDLED_CRITICAL_EXTENSION},

    {"has_critical_ct_extension.pem", OCSPRevocationStatus::GOOD,
     OCSPVerifyResult::PROVIDED},

    {"missing_response.pem", OCSPRevocationStatus::UNKNOWN,
     OCSPVerifyResult::NO_MATCHING_RESPONSE},
};

// Parameterised test name generator for tests depending on RenderTextBackend.
struct PrintTestName {
  std::string operator()(const testing::TestParamInfo<TestParams> &info) const {
    std::string_view name(info.param.file_name);
    // Strip ".pem" from the end as GTest names cannot contain period.
    name.remove_suffix(4);
    return std::string(name);
  }
};

INSTANTIATE_TEST_SUITE_P(All, CheckOCSPTest, ::testing::ValuesIn(kTestParams),
                         PrintTestName());

TEST_P(CheckOCSPTest, FromFile) {
  const TestParams &params = GetParam();

  std::string ocsp_data;
  std::string ca_data;
  std::string cert_data;
  std::string request_data;
  const PemBlockMapping mappings[] = {
      {"OCSP RESPONSE", &ocsp_data},
      {"CA CERTIFICATE", &ca_data},
      {"CERTIFICATE", &cert_data},
      {"OCSP REQUEST", &request_data},
  };

  ASSERT_TRUE(ReadTestDataFromPemFile(GetFilePath(params.file_name), mappings));

  // Mar 5 00:00:00 2017 GMT
  int64_t kVerifyTime = 1488672000;

  // Test that CheckOCSP() works.
  OCSPVerifyResult::ResponseStatus response_status;
  OCSPRevocationStatus revocation_status =
      CheckOCSP(ocsp_data, cert_data, ca_data, kVerifyTime, kOCSPAgeOneWeek,
                &response_status);

  EXPECT_EQ(params.expected_revocation_status, revocation_status);
  EXPECT_EQ(params.expected_response_status, response_status);

  // Check that CreateOCSPRequest() works.
  std::shared_ptr<const ParsedCertificate> cert = ParseCertificate(cert_data);
  ASSERT_TRUE(cert);

  std::shared_ptr<const ParsedCertificate> issuer = ParseCertificate(ca_data);
  ASSERT_TRUE(issuer);

  std::vector<uint8_t> encoded_request;
  ASSERT_TRUE(CreateOCSPRequest(cert.get(), issuer.get(), &encoded_request));

  EXPECT_EQ(der::Input(encoded_request),
            der::Input(StringAsBytes(request_data)));
}

std::string_view kGetURLTestParams[] = {
    "http://www.example.com/",
    "http://www.example.com/path/",
    "http://www.example.com/path",
    "http://www.example.com/path?query"
    "http://user:pass@www.example.com/path?query",
};

class CreateOCSPGetURLTest : public ::testing::TestWithParam<std::string_view> {
};

INSTANTIATE_TEST_SUITE_P(All, CreateOCSPGetURLTest,
                         ::testing::ValuesIn(kGetURLTestParams));

TEST_P(CreateOCSPGetURLTest, Basic) {
  std::string ca_data;
  std::string cert_data;
  std::string request_data;
  const PemBlockMapping mappings[] = {
      {"CA CERTIFICATE", &ca_data},
      {"CERTIFICATE", &cert_data},
      {"OCSP REQUEST", &request_data},
  };

  // Load one of the test files. (Doesn't really matter which one as
  // constructing the DER is tested elsewhere).
  ASSERT_TRUE(
      ReadTestDataFromPemFile(GetFilePath("good_response.pem"), mappings));

  std::shared_ptr<const ParsedCertificate> cert = ParseCertificate(cert_data);
  ASSERT_TRUE(cert);

  std::shared_ptr<const ParsedCertificate> issuer = ParseCertificate(ca_data);
  ASSERT_TRUE(issuer);

  std::optional<std::string> url =
      CreateOCSPGetURL(cert.get(), issuer.get(), GetParam());
  ASSERT_TRUE(url);

  // Try to extract the encoded data and compare against |request_data|.
  //
  // A known answer output test would be better as this just reverses the logic
  // from the implementation file.
  std::string b64 = url->substr(GetParam().size() + 1);

  // Hex un-escape the data.
  b64 = bssl::string_util::FindAndReplace(b64, "%2B", "+");
  b64 = bssl::string_util::FindAndReplace(b64, "%2F", "/");
  b64 = bssl::string_util::FindAndReplace(b64, "%3D", "=");

  // Base64 decode the data.
  size_t len;
  EXPECT_TRUE(EVP_DecodedLength(&len, b64.size()));
  std::vector<uint8_t> decoded(len);
  EXPECT_TRUE(EVP_DecodeBase64(decoded.data(), &len, len,
                               reinterpret_cast<const uint8_t *>(b64.data()),
                               b64.size()));
  std::string decoded_string(decoded.begin(), decoded.begin() + len);

  EXPECT_EQ(request_data, decoded_string);
}

}  // namespace

BSSL_NAMESPACE_END
