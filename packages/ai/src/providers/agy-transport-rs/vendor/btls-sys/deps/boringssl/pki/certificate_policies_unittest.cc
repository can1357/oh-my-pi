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

#include "certificate_policies.h"

#include <gtest/gtest.h>

#include <openssl/span.h>

#include "input.h"
#include "parser.h"
#include "test_helpers.h"

BSSL_NAMESPACE_BEGIN
namespace {

::testing::AssertionResult LoadTestData(const std::string &name,
                                        std::string *result) {
  std::string path = "testdata/certificate_policies_unittest/" + name;

  const PemBlockMapping mappings[] = {
      {"CERTIFICATE POLICIES", result},
  };

  return ReadTestDataFromPemFile(path, mappings);
}

const uint8_t policy_1_2_3_der[] = {0x2A, 0x03};
const uint8_t policy_1_2_4_der[] = {0x2A, 0x04};

class ParseCertificatePoliciesExtensionOidsTest
    : public testing::TestWithParam<bool> {
 protected:
  bool fail_parsing_unknown_qualifier_oids() const { return GetParam(); }
};

// Run the tests with all possible values for
// |fail_parsing_unknown_qualifier_oids|.
INSTANTIATE_TEST_SUITE_P(All, ParseCertificatePoliciesExtensionOidsTest,
                         testing::Bool());

TEST_P(ParseCertificatePoliciesExtensionOidsTest, InvalidEmpty) {
  std::string der;
  ASSERT_TRUE(LoadTestData("invalid-empty.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest, InvalidIdentifierNotOid) {
  std::string der;
  ASSERT_TRUE(LoadTestData("invalid-policy_identifier_not_oid.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest, AnyPolicy) {
  std::string der;
  ASSERT_TRUE(LoadTestData("anypolicy.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
  ASSERT_EQ(1U, policies.size());
  EXPECT_EQ(der::Input(kAnyPolicyOid), policies[0]);
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest, AnyPolicyWithQualifier) {
  std::string der;
  ASSERT_TRUE(LoadTestData("anypolicy_with_qualifier.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
  ASSERT_EQ(1U, policies.size());
  EXPECT_EQ(der::Input(kAnyPolicyOid), policies[0]);
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest,
       InvalidAnyPolicyWithCustomQualifier) {
  std::string der;
  ASSERT_TRUE(
      LoadTestData("invalid-anypolicy_with_custom_qualifier.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest, OnePolicy) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
  ASSERT_EQ(1U, policies.size());
  EXPECT_EQ(der::Input(policy_1_2_3_der), policies[0]);
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest, OnePolicyWithQualifier) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3_with_qualifier.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
  ASSERT_EQ(1U, policies.size());
  EXPECT_EQ(der::Input(policy_1_2_3_der), policies[0]);
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest,
       OnePolicyWithCustomQualifier) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3_with_custom_qualifier.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  bool result = ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors);

  if (fail_parsing_unknown_qualifier_oids()) {
    EXPECT_FALSE(result);
  } else {
    EXPECT_TRUE(result);
    ASSERT_EQ(1U, policies.size());
    EXPECT_EQ(der::Input(policy_1_2_3_der), policies[0]);
  }
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest,
       InvalidPolicyWithDuplicatePolicyOid) {
  std::string der;
  ASSERT_TRUE(LoadTestData("invalid-policy_1_2_3_dupe.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest,
       InvalidPolicyWithEmptyQualifiersSequence) {
  std::string der;
  ASSERT_TRUE(LoadTestData(
      "invalid-policy_1_2_3_with_empty_qualifiers_sequence.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest,
       InvalidPolicyInformationHasUnconsumedData) {
  std::string der;
  ASSERT_TRUE(LoadTestData(
      "invalid-policy_1_2_3_policyinformation_unconsumed_data.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest,
       InvalidPolicyQualifierInfoHasUnconsumedData) {
  std::string der;
  ASSERT_TRUE(LoadTestData(
      "invalid-policy_1_2_3_policyqualifierinfo_unconsumed_data.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest, TwoPolicies) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3_and_1_2_4.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
  ASSERT_EQ(2U, policies.size());
  EXPECT_EQ(der::Input(policy_1_2_3_der), policies[0]);
  EXPECT_EQ(der::Input(policy_1_2_4_der), policies[1]);
}

TEST_P(ParseCertificatePoliciesExtensionOidsTest, TwoPoliciesWithQualifiers) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3_and_1_2_4_with_qualifiers.pem", &der));
  std::vector<der::Input> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtensionOids(
      StringAsBytes(der), fail_parsing_unknown_qualifier_oids(), &policies,
      &errors));
  ASSERT_EQ(2U, policies.size());
  EXPECT_EQ(der::Input(policy_1_2_3_der), policies[0]);
  EXPECT_EQ(der::Input(policy_1_2_4_der), policies[1]);
}

TEST(ParseCertificatePoliciesExtensionTest, InvalidEmpty) {
  std::string der;
  ASSERT_TRUE(LoadTestData("invalid-empty.pem", &der));
  std::vector<PolicyInformation> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtension(StringAsBytes(der), &policies,
                                                 &errors));
}

TEST(ParseCertificatePoliciesExtensionTest,
     InvalidPolicyWithDuplicatePolicyOid) {
  std::string der;
  ASSERT_TRUE(LoadTestData("invalid-policy_1_2_3_dupe.pem", &der));
  std::vector<PolicyInformation> policies;
  CertErrors errors;
  EXPECT_FALSE(ParseCertificatePoliciesExtension(StringAsBytes(der), &policies,
                                                 &errors));
}

TEST(ParseCertificatePoliciesExtensionTest, OnePolicyWithCustomQualifier) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3_with_custom_qualifier.pem", &der));
  std::vector<PolicyInformation> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtension(StringAsBytes(der), &policies,
                                                &errors));
  ASSERT_EQ(1U, policies.size());
  PolicyInformation &policy = policies[0];
  EXPECT_EQ(der::Input(policy_1_2_3_der), policy.policy_oid);

  ASSERT_EQ(1U, policy.policy_qualifiers.size());
  PolicyQualifierInfo &qualifier = policy.policy_qualifiers[0];
  // 1.2.3.4
  const uint8_t kExpectedQualifierOid[] = {0x2a, 0x03, 0x04};
  EXPECT_EQ(der::Input(kExpectedQualifierOid), qualifier.qualifier_oid);
  // UTF8String { "hi" }
  const uint8_t kExpectedQualifier[] = {0x0c, 0x02, 0x68, 0x69};
  EXPECT_EQ(der::Input(kExpectedQualifier), qualifier.qualifier);
}

TEST(ParseCertificatePoliciesExtensionTest, TwoPolicies) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3_and_1_2_4.pem", &der));
  std::vector<PolicyInformation> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtension(StringAsBytes(der), &policies,
                                                &errors));
  ASSERT_EQ(2U, policies.size());
  {
    PolicyInformation &policy = policies[0];
    EXPECT_EQ(der::Input(policy_1_2_3_der), policy.policy_oid);
    EXPECT_EQ(0U, policy.policy_qualifiers.size());
  }
  {
    PolicyInformation &policy = policies[1];
    EXPECT_EQ(der::Input(policy_1_2_4_der), policy.policy_oid);
    EXPECT_EQ(0U, policy.policy_qualifiers.size());
  }
}

TEST(ParseCertificatePoliciesExtensionTest, TwoPoliciesWithQualifiers) {
  std::string der;
  ASSERT_TRUE(LoadTestData("policy_1_2_3_and_1_2_4_with_qualifiers.pem", &der));
  std::vector<PolicyInformation> policies;
  CertErrors errors;
  EXPECT_TRUE(ParseCertificatePoliciesExtension(StringAsBytes(der), &policies,
                                                &errors));
  ASSERT_EQ(2U, policies.size());
  {
    PolicyInformation &policy = policies[0];
    EXPECT_EQ(der::Input(policy_1_2_3_der), policy.policy_oid);
    ASSERT_EQ(1U, policy.policy_qualifiers.size());
    PolicyQualifierInfo &qualifier = policy.policy_qualifiers[0];
    EXPECT_EQ(der::Input(kCpsPointerId), qualifier.qualifier_oid);
    // IA5String { "https://example.com/1_2_3" }
    const uint8_t kExpectedQualifier[] = {
        0x16, 0x19, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f,
        0x2f, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e,
        0x63, 0x6f, 0x6d, 0x2f, 0x31, 0x5f, 0x32, 0x5f, 0x33};
    EXPECT_EQ(der::Input(kExpectedQualifier), qualifier.qualifier);
  }
  {
    PolicyInformation &policy = policies[1];
    EXPECT_EQ(der::Input(policy_1_2_4_der), policy.policy_oid);
    ASSERT_EQ(1U, policy.policy_qualifiers.size());
    PolicyQualifierInfo &qualifier = policy.policy_qualifiers[0];
    EXPECT_EQ(der::Input(kCpsPointerId), qualifier.qualifier_oid);
    // IA5String { "http://example.com/1_2_4" }
    const uint8_t kExpectedQualifier[] = {
        0x16, 0x18, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f,
        0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x63,
        0x6f, 0x6d, 0x2f, 0x31, 0x5f, 0x32, 0x5f, 0x34};
    EXPECT_EQ(der::Input(kExpectedQualifier), qualifier.qualifier);
  }
}

// NOTE: The tests for ParseInhibitAnyPolicy() are part of
// parsed_certificate_unittest.cc

}  // namespace
BSSL_NAMESPACE_END
