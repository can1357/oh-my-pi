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

#include "test_helpers.h"

#include <fstream>
#include <iostream>
#include <sstream>
#include <streambuf>
#include <string>
#include <string_view>

#include <gtest/gtest.h>

#include <openssl/bytestring.h>
#include <openssl/mem.h>
#include <openssl/pool.h>
#include <openssl/span.h>

#include "../crypto/test/test_data.h"
#include "cert_error_params.h"
#include "cert_errors.h"
#include "parse_values.h"
#include "parser.h"
#include "pem.h"
#include "simple_path_builder_delegate.h"
#include "string_util.h"
#include "trust_store.h"

BSSL_NAMESPACE_BEGIN

namespace {

bool GetValue(std::string_view prefix, std::string_view line,
              std::string *value, bool *has_value) {
  if (!bssl::string_util::StartsWith(line, prefix)) {
    return false;
  }

  if (*has_value) {
    ADD_FAILURE() << "Duplicated " << prefix;
    return false;
  }

  *has_value = true;
  *value = std::string(line.substr(prefix.size()));
  return true;
}

// Returns a string containing the dotted numeric form of |oid|, or a
// hex-encoded string on error.
std::string OidToString(der::Input oid) {
  CBS cbs;
  CBS_init(&cbs, oid.data(), oid.size());
  bssl::UniquePtr<char> text(CBS_asn1_oid_to_text(&cbs));
  if (!text) {
    return "invalid:" + bssl::string_util::HexEncode(oid);
  }
  return text.get();
}

std::string StrSetToString(const std::set<std::string> &str_set) {
  std::string out;
  for (const auto &s : str_set) {
    EXPECT_FALSE(s.empty());
    if (!out.empty()) {
      out += ", ";
    }
    out += s;
  }
  return out;
}

std::string StripString(std::string_view str) {
  size_t start = str.find_first_not_of(' ');
  if (start == str.npos) {
    return std::string();
  }
  str = str.substr(start);
  size_t end = str.find_last_not_of(' ');
  if (end != str.npos) {
    ++end;
  }
  return std::string(str.substr(0, end));
}

std::vector<std::string> SplitString(std::string_view str) {
  std::vector<std::string_view> split = string_util::SplitString(str, ',');

  std::vector<std::string> out;
  for (const auto &s : split) {
    out.push_back(StripString(s));
  }
  return out;
}

}  // namespace

namespace der {

void PrintTo(Input data, ::std::ostream *os) {
  size_t len;
  if (!EVP_EncodedLength(&len, data.size())) {
    *os << "[]";
    return;
  }
  std::vector<uint8_t> encoded(len);
  len = EVP_EncodeBlock(encoded.data(), data.data(), data.size());
  // Skip the trailing \0.
  std::string b64_encoded(encoded.begin(), encoded.begin() + len);
  *os << "[" << b64_encoded << "]";
}

}  // namespace der

der::Input SequenceValueFromString(std::string_view s) {
  der::Parser parser(StringAsBytes(s));
  der::Input data;
  if (!parser.ReadTag(CBS_ASN1_SEQUENCE, &data)) {
    ADD_FAILURE();
    return der::Input();
  }
  if (parser.HasMore()) {
    ADD_FAILURE();
    return der::Input();
  }
  return data;
}

::testing::AssertionResult ReadTestDataFromPemFile(
    const std::string &file_path_ascii, const PemBlockMapping *mappings,
    size_t mappings_length) {
  std::string file_data = ReadTestFileToString(file_path_ascii);

  // mappings_copy is used to keep track of which mappings have already been
  // satisfied (by nulling the |value| field). This is used to track when
  // blocks are multiply defined.
  std::vector<PemBlockMapping> mappings_copy(mappings,
                                             mappings + mappings_length);

  // Build the |pem_headers| vector needed for PEMTokenzier.
  std::vector<std::string> pem_headers;
  for (const auto &mapping : mappings_copy) {
    pem_headers.push_back(mapping.block_name);
  }

  PEMTokenizer pem_tokenizer(file_data, pem_headers);
  while (pem_tokenizer.GetNext()) {
    for (auto &mapping : mappings_copy) {
      // Find the mapping for this block type.
      if (pem_tokenizer.block_type() == mapping.block_name) {
        if (!mapping.value) {
          return ::testing::AssertionFailure()
                 << "PEM block defined multiple times: " << mapping.block_name;
        }

        // Copy the data to the result.
        mapping.value->assign(pem_tokenizer.data());

        // Mark the mapping as having been satisfied.
        mapping.value = nullptr;
      }
    }
  }

  // Ensure that all specified blocks were found.
  for (const auto &mapping : mappings_copy) {
    if (mapping.value && !mapping.optional) {
      return ::testing::AssertionFailure()
             << "PEM block missing: " << mapping.block_name;
    }
  }

  return ::testing::AssertionSuccess();
}

VerifyCertChainTest::VerifyCertChainTest()
    : user_initial_policy_set{der::Input(kAnyPolicyOid)} {}
VerifyCertChainTest::~VerifyCertChainTest() = default;

bool VerifyCertChainTest::HasHighSeverityErrors() const {
  // This function assumes that high severity warnings are prefixed with
  // "ERROR: " and warnings are prefixed with "WARNING: ". This is an
  // implementation detail of CertError::ToDebugString).
  //
  // Do a quick sanity-check to confirm this.
  CertError error(CertError::SEVERITY_HIGH, "unused", nullptr);
  EXPECT_EQ("ERROR: unused\n", error.ToDebugString());
  CertError warning(CertError::SEVERITY_WARNING, "unused", nullptr);
  EXPECT_EQ("WARNING: unused\n", warning.ToDebugString());

  // Do a simple substring test (not perfect, but good enough for our test
  // corpus).
  return expected_errors.find("ERROR: ") != std::string::npos;
}

bool ReadCertChainFromFile(const std::string &file_path_ascii,
                           ParsedCertificateList *chain) {
  // Reset all the out parameters to their defaults.
  *chain = ParsedCertificateList();

  std::string file_data = ReadTestFileToString(file_path_ascii);
  if (file_data.empty()) {
    return false;
  }

  std::vector<std::string> pem_headers = {"CERTIFICATE"};

  PEMTokenizer pem_tokenizer(file_data, pem_headers);
  while (pem_tokenizer.GetNext()) {
    const std::string &block_data = pem_tokenizer.data();

    CertErrors errors;
    if (!ParsedCertificate::CreateAndAddToVector(
            bssl::UniquePtr<CRYPTO_BUFFER>(CRYPTO_BUFFER_new(
                reinterpret_cast<const uint8_t *>(block_data.data()),
                block_data.size(), nullptr)),
            {}, chain, &errors)) {
      ADD_FAILURE() << errors.ToDebugString();
      return false;
    }
  }

  return true;
}

std::shared_ptr<const ParsedCertificate> ReadCertFromFile(
    const std::string &file_path_ascii) {
  ParsedCertificateList chain;
  if (!ReadCertChainFromFile(file_path_ascii, &chain)) {
    return nullptr;
  }
  if (chain.size() != 1) {
    return nullptr;
  }
  return chain[0];
}

bool ReadVerifyCertChainTestFromFile(const std::string &file_path_ascii,
                                     VerifyCertChainTest *test) {
  // Reset all the out parameters to their defaults.
  *test = {};

  std::string file_data = ReadTestFileToString(file_path_ascii);
  if (file_data.empty()) {
    return false;
  }

  bool has_chain = false;
  bool has_trust = false;
  bool has_time = false;
  bool has_errors = false;
  bool has_key_purpose = false;
  bool has_digest_policy = false;
  bool has_user_constrained_policy_set = false;

  std::string kExpectedErrors = "expected_errors:";

  std::istringstream stream(file_data);
  for (std::string line; std::getline(stream, line, '\n');) {
    size_t start = line.find_first_not_of(" \n\t\r\f\v");
    if (start == std::string::npos) {
      continue;
    }
    size_t end = line.find_last_not_of(" \n\t\r\f\v");
    if (end == std::string::npos) {
      continue;
    }
    line = line.substr(start, end + 1);
    if (line.empty()) {
      continue;
    }
    std::string_view line_piece(line);

    std::string value;

    // For details on the file format refer to:
    // net/data/verify_certificate_chain_unittest/README.
    if (GetValue("chain: ", line_piece, &value, &has_chain)) {
      // Interpret the |chain| path as being relative to the .test file.
      size_t slash = file_path_ascii.rfind('/');
      if (slash == std::string::npos) {
        ADD_FAILURE() << "Bad path - expecting slashes";
        return false;
      }
      std::string chain_path = file_path_ascii.substr(0, slash) + "/" + value;

      ReadCertChainFromFile(chain_path, &test->chain);
    } else if (GetValue("utc_time: ", line_piece, &value, &has_time)) {
      if (value == "DEFAULT") {
        value = "211005120000Z";
      }
      if (!der::ParseUTCTime(StringAsBytes(value), &test->time)) {
        ADD_FAILURE() << "Failed parsing UTC time";
        return false;
      }
    } else if (GetValue("key_purpose: ", line_piece, &value,
                        &has_key_purpose)) {
      if (value == "ANY_EKU") {
        test->key_purpose = KeyPurpose::ANY_EKU;
      } else if (value == "SERVER_AUTH") {
        test->key_purpose = KeyPurpose::SERVER_AUTH;
      } else if (value == "CLIENT_AUTH") {
        test->key_purpose = KeyPurpose::CLIENT_AUTH;
      } else if (value == "SERVER_AUTH_STRICT") {
        test->key_purpose = KeyPurpose::SERVER_AUTH_STRICT;
      } else if (value == "CLIENT_AUTH_STRICT") {
        test->key_purpose = KeyPurpose::CLIENT_AUTH_STRICT;
      } else if (value == "SERVER_AUTH_STRICT_LEAF") {
        test->key_purpose = KeyPurpose::SERVER_AUTH_STRICT_LEAF;
      } else if (value == "CLIENT_AUTH_STRICT_LEAF") {
        test->key_purpose = KeyPurpose::CLIENT_AUTH_STRICT_LEAF;
      } else if (value == "MLS_CLIENT_AUTH") {
        test->key_purpose = KeyPurpose::RCS_MLS_CLIENT_AUTH;
      } else if (value == "C2PA_TIMESTAMPING") {
        test->key_purpose = KeyPurpose::C2PA_TIMESTAMPING;
      } else if (value == "C2PA_MANIFEST") {
        test->key_purpose = KeyPurpose::C2PA_MANIFEST;
      } else {
        ADD_FAILURE() << "Unrecognized key_purpose: " << value;
        return false;
      }
    } else if (GetValue("last_cert_trust: ", line_piece, &value, &has_trust)) {
      // TODO(mattm): convert test files to use
      // CertificateTrust::FromDebugString strings.
      if (value == "TRUSTED_ANCHOR") {
        test->last_cert_trust = CertificateTrust::ForTrustAnchor();
      } else if (value == "TRUSTED_ANCHOR_WITH_EXPIRATION") {
        test->last_cert_trust =
            CertificateTrust::ForTrustAnchor().WithEnforceAnchorExpiry();
      } else if (value == "TRUSTED_ANCHOR_WITH_CONSTRAINTS") {
        test->last_cert_trust =
            CertificateTrust::ForTrustAnchor().WithEnforceAnchorConstraints();
      } else if (value == "TRUSTED_ANCHOR_WITH_REQUIRE_BASIC_CONSTRAINTS") {
        test->last_cert_trust = CertificateTrust::ForTrustAnchor()
                                    .WithRequireAnchorBasicConstraints();
      } else if (value ==
                 "TRUSTED_ANCHOR_WITH_CONSTRAINTS_REQUIRE_BASIC_CONSTRAINTS") {
        test->last_cert_trust = CertificateTrust::ForTrustAnchor()
                                    .WithEnforceAnchorConstraints()
                                    .WithRequireAnchorBasicConstraints();
      } else if (value == "TRUSTED_ANCHOR_WITH_EXPIRATION_AND_CONSTRAINTS") {
        test->last_cert_trust = CertificateTrust::ForTrustAnchor()
                                    .WithEnforceAnchorExpiry()
                                    .WithEnforceAnchorConstraints();
      } else if (value == "TRUSTED_ANCHOR_OR_LEAF") {
        test->last_cert_trust = CertificateTrust::ForTrustAnchorOrLeaf();
      } else if (value == "TRUSTED_LEAF") {
        test->last_cert_trust = CertificateTrust::ForTrustedLeaf();
      } else if (value == "TRUSTED_LEAF_REQUIRE_SELF_SIGNED") {
        test->last_cert_trust =
            CertificateTrust::ForTrustedLeaf().WithRequireLeafSelfSigned();
      } else if (value == "DISTRUSTED") {
        test->last_cert_trust = CertificateTrust::ForDistrusted();
      } else if (value == "UNSPECIFIED") {
        test->last_cert_trust = CertificateTrust::ForUnspecified();
      } else {
        ADD_FAILURE() << "Unrecognized last_cert_trust: " << value;
        return false;
      }
    } else if (GetValue("digest_policy: ", line_piece, &value,
                        &has_digest_policy)) {
      if (value == "STRONG") {
        test->digest_policy = SimplePathBuilderDelegate::DigestPolicy::kStrong;
      } else if (value == "ALLOW_SHA_1") {
        test->digest_policy =
            SimplePathBuilderDelegate::DigestPolicy::kWeakAllowSha1;
      } else {
        ADD_FAILURE() << "Unrecognized digest_policy: " << value;
        return false;
      }
    } else if (GetValue("expected_user_constrained_policy_set: ", line_piece,
                        &value, &has_user_constrained_policy_set)) {
      std::vector<std::string> split_value(SplitString(value));
      test->expected_user_constrained_policy_set =
          std::set<std::string>(split_value.begin(), split_value.end());
    } else if (bssl::string_util::StartsWith(line_piece, "#")) {
      // Skip comments.
      continue;
    } else if (line_piece == kExpectedErrors) {
      has_errors = true;
      // The errors start on the next line, and extend until the end of the
      // file.
      std::string prefix =
          std::string("\n") + kExpectedErrors + std::string("\n");
      size_t errors_start = file_data.find(prefix);
      if (errors_start == std::string::npos) {
        ADD_FAILURE() << "expected_errors not found";
        return false;
      }
      test->expected_errors = file_data.substr(errors_start + prefix.size());
      break;
    } else {
      ADD_FAILURE() << "Unknown line: " << line_piece;
      return false;
    }
  }

  if (!has_chain) {
    ADD_FAILURE() << "Missing chain: ";
    return false;
  }

  if (!has_trust) {
    ADD_FAILURE() << "Missing last_cert_trust: ";
    return false;
  }

  if (!has_time) {
    ADD_FAILURE() << "Missing time: ";
    return false;
  }

  if (!has_key_purpose) {
    ADD_FAILURE() << "Missing key_purpose: ";
    return false;
  }

  if (!has_errors) {
    ADD_FAILURE() << "Missing errors:";
    return false;
  }

  // `has_user_constrained_policy_set` is intentionally not checked here. Not
  // specifying expected_user_constrained_policy_set means the expected policy
  // set is empty.

  return true;
}

std::string ReadTestFileToString(const std::string &file_path_ascii) {
  return GetTestData(("pki/" + file_path_ascii).c_str());
}

void VerifyCertPathErrors(const std::string &expected_errors_str,
                          const CertPathErrors &actual_errors,
                          const ParsedCertificateList &chain,
                          const std::string &errors_file_path) {
  std::string actual_errors_str = actual_errors.ToDebugString(chain);

  if (expected_errors_str != actual_errors_str) {
    ADD_FAILURE() << "Cert path errors don't match expectations ("
                  << errors_file_path << ")\n\n"
                  << "EXPECTED:\n\n"
                  << expected_errors_str << "\n"
                  << "ACTUAL:\n\n"
                  << actual_errors_str << "\n"
                  << "===> Use "
                     "pki/testdata/verify_certificate_chain_unittest/"
                     "rebase-errors.py to rebaseline.\n";
  }
}

void VerifyCertErrors(const std::string &expected_errors_str,
                      const CertErrors &actual_errors,
                      const std::string &errors_file_path) {
  std::string actual_errors_str = actual_errors.ToDebugString();

  if (expected_errors_str != actual_errors_str) {
    ADD_FAILURE() << "Cert errors don't match expectations ("
                  << errors_file_path << ")\n\n"
                  << "EXPECTED:\n\n"
                  << expected_errors_str << "\n"
                  << "ACTUAL:\n\n"
                  << actual_errors_str << "\n"
                  << "===> Use "
                     "pki/testdata/parse_certificate_unittest/"
                     "rebase-errors.py to rebaseline.\n";
  }
}

void VerifyUserConstrainedPolicySet(
    const std::set<std::string> &expected_user_constrained_policy_str_set,
    const std::set<der::Input> &actual_user_constrained_policy_set,
    const std::string &errors_file_path) {
  std::set<std::string> actual_user_constrained_policy_str_set;
  for (der::Input der_oid : actual_user_constrained_policy_set) {
    actual_user_constrained_policy_str_set.insert(OidToString(der_oid));
  }
  if (expected_user_constrained_policy_str_set !=
      actual_user_constrained_policy_str_set) {
    ADD_FAILURE() << "user_constrained_policy_set doesn't match expectations ("
                  << errors_file_path << ")\n\n"
                  << "EXPECTED: "
                  << StrSetToString(expected_user_constrained_policy_str_set)
                  << "\n"
                  << "ACTUAL: "
                  << StrSetToString(actual_user_constrained_policy_str_set)
                  << "\n";
  }
}

BSSL_NAMESPACE_END
