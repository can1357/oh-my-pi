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

#include "verify_certificate_chain.h"

#include <openssl/pool.h>
#include "input.h"
#include "parsed_certificate.h"
#include "simple_path_builder_delegate.h"
#include "trust_store.h"

// These require CRL support, which is not implemented at the
// VerifyCertificateChain level.
#define Section7InvalidkeyUsageCriticalcRLSignFalseTest4 \
  DISABLED_Section7InvalidkeyUsageCriticalcRLSignFalseTest4
#define Section7InvalidkeyUsageNotCriticalcRLSignFalseTest5 \
  DISABLED_Section7InvalidkeyUsageNotCriticalcRLSignFalseTest5

#include "nist_pkits_unittest.h"

BSSL_NAMESPACE_BEGIN

namespace {

class VerifyCertificateChainPkitsTestDelegate {
 public:
  static void RunTest(std::vector<std::string> cert_ders,
                      std::vector<std::string> crl_ders,
                      const PkitsTestInfo &info) {
    ASSERT_FALSE(cert_ders.empty());

    // PKITS lists chains from trust anchor to target, whereas
    // VerifyCertificateChain takes them starting with the target and ending
    // with the trust anchor.
    std::vector<std::shared_ptr<const ParsedCertificate>> input_chain;
    CertErrors parsing_errors;
    for (auto i = cert_ders.rbegin(); i != cert_ders.rend(); ++i) {
      ASSERT_TRUE(ParsedCertificate::CreateAndAddToVector(
          bssl::UniquePtr<CRYPTO_BUFFER>(
              CRYPTO_BUFFER_new(reinterpret_cast<const uint8_t *>(i->data()),
                                i->size(), nullptr)),
          {}, &input_chain, &parsing_errors))
          << parsing_errors.ToDebugString();
    }

    SimplePathBuilderDelegate path_builder_delegate(
        1024, SimplePathBuilderDelegate::DigestPolicy::kWeakAllowSha1);

    std::set<der::Input> user_constrained_policy_set;

    CertPathErrors path_errors;
    VerifyCertificateChain(
        input_chain, CertificateTrust::ForTrustAnchor(), &path_builder_delegate,
        info.time, KeyPurpose::ANY_EKU, info.initial_explicit_policy,
        info.initial_policy_set, info.initial_policy_mapping_inhibit,
        info.initial_inhibit_any_policy, &user_constrained_policy_set,
        &path_errors);
    bool did_succeed = !path_errors.ContainsHighSeverityErrors();

    EXPECT_EQ(info.should_validate, did_succeed);
    EXPECT_EQ(info.user_constrained_policy_set, user_constrained_policy_set);

    // Check that the errors match expectations. The errors are saved in a
    // parallel file, as they don't apply generically to the third_party
    // PKITS data.
    if (!info.should_validate && !did_succeed) {
      std::string errors_file_path =
          std::string(
              "testdata/verify_certificate_chain_unittest/pkits_errors/") +
          info.test_number + std::string(".txt");

      std::string expected_errors = ReadTestFileToString(errors_file_path);

      // Check that the errors match.
      VerifyCertPathErrors(expected_errors, path_errors, input_chain,
                           errors_file_path);
    } else if (!did_succeed) {
      // If it failed and wasn't supposed to fail, print the errors.
      EXPECT_EQ("", path_errors.ToDebugString(input_chain));
    }
  }
};

}  // namespace

INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest01SignatureVerification,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest02ValidityPeriods,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest03VerifyingNameChaining,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest06VerifyingBasicConstraints,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain, PkitsTest07KeyUsage,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest08CertificatePolicies,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest09RequireExplicitPolicy,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest10PolicyMappings,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest11InhibitPolicyMapping,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest12InhibitAnyPolicy,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest13NameConstraints,
                               VerifyCertificateChainPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(VerifyCertificateChain,
                               PkitsTest16PrivateCertificateExtensions,
                               VerifyCertificateChainPkitsTestDelegate);

// These require CRL support, which is not implemented at the
// VerifyCertificateChain level:
// PkitsTest04BasicCertificateRevocationTests,
// PkitsTest05VerifyingPathswithSelfIssuedCertificates,
// PkitsTest14DistributionPoints, PkitsTest15DeltaCRLs

BSSL_NAMESPACE_END
